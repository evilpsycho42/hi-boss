import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

import {
  classifyMagicNumber,
  describeEnvVar,
  describeMagicCategory,
  describeMagicValue,
  describePath,
  evaluatePathExpression,
  extractSchemaDefaults,
  formatOccurrences,
  getNumericLiteralText,
  getOccurrence,
  isConstVariableDeclaration,
  isInterestingRuntimePath,
  isProcessEnv,
  makePlaceholder,
  parseArgs,
  resolveConstString,
  toPosixPath,
  unwrapExpression,
  type InventoryItem,
  type MagicCategory,
  type MagicOccurrence,
  type Occurrence,
} from "./helpers.js";

export function runMagicInventoryCli(argv: string[]): void {
  const { outPath } = parseArgs(argv);
  const repoRoot = process.cwd();
  const outAbs = path.resolve(repoRoot, outPath);

  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("tsconfig.json not found");

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();

  const envVars = new Map<string, Occurrence[]>();
  const runtimePaths = new Map<string, { occurrences: Occurrence[]; usedDefaultDataDir: boolean }>();
  const magicOccurrences: MagicOccurrence[] = [];

  // Include DB/schema defaults from SQL string.
  magicOccurrences.push(...extractSchemaDefaults(repoRoot));

  const sourceFiles = program.getSourceFiles().filter((sf) => {
    const rel = toPosixPath(path.relative(repoRoot, sf.fileName));
    if (rel.startsWith("..")) return false;
    if (!rel.endsWith(".ts")) return false;
    if (rel.startsWith("dist/") || rel.includes("/dist/")) return false;
    if (rel.startsWith("node_modules/") || rel.includes("/node_modules/")) return false;
    return rel.startsWith("src/") || rel.startsWith("bin/");
  });

  for (const sourceFile of sourceFiles) {
    function visit(node: ts.Node): void {
      // Environment variables
      if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
        const name = node.name.text;
        const occ = getOccurrence(repoRoot, sourceFile, node.name);
        envVars.set(name, [...(envVars.get(name) ?? []), occ]);
      }

      if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression) && node.argumentExpression) {
        const name = resolveConstString(checker, node.argumentExpression);
        if (name) {
          const occ = getOccurrence(repoRoot, sourceFile, node.argumentExpression);
          envVars.set(name, [...(envVars.get(name) ?? []), occ]);
        }
      }

      // Capture computed env var keys (e.g., { [HIBOSS_TOKEN_ENV]: ... })
      if (ts.isComputedPropertyName(node)) {
        const name = resolveConstString(checker, node.expression);
        if (name && /^[A-Z0-9_]+$/.test(name)) {
          const occ = getOccurrence(repoRoot, sourceFile, node.expression);
          envVars.set(name, [...(envVars.get(name) ?? []), occ]);
        }
      }

      // Runtime paths (path.join / path.resolve)
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
          const receiver = callee.expression.text;
          const method = callee.name.text;
          if (receiver === "path" && (method === "join" || method === "resolve")) {
            const evaluated = evaluatePathExpression(checker, node, sourceFile);
            if (evaluated && isInterestingRuntimePath(evaluated.text)) {
              const occ = getOccurrence(repoRoot, sourceFile, node);
              const existing = runtimePaths.get(evaluated.text);
              if (existing) {
                existing.occurrences.push(occ);
                existing.usedDefaultDataDir = existing.usedDefaultDataDir || evaluated.usedDefaultDataDir;
              } else {
                runtimePaths.set(evaluated.text, {
                  occurrences: [occ],
                  usedDefaultDataDir: evaluated.usedDefaultDataDir,
                });
              }
            }
          }
        }

        // Magic numbers: timeouts / intervals / socket timeout
        if (ts.isIdentifier(node.expression) && (node.expression.text === "setTimeout" || node.expression.text === "setInterval")) {
          const delayArg = node.arguments[1];
          if (delayArg) {
            const value = getNumericLiteralText(delayArg, sourceFile);
            if (value) {
              const occ = getOccurrence(repoRoot, sourceFile, delayArg);
              magicOccurrences.push({
                category: "Timeouts",
                value,
                label: `${node.expression.text} delay (ms)`,
                occurrence: occ,
              });
            }
          }
        }

        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "setTimeout") {
          const delayArg = node.arguments[0];
          if (delayArg) {
            const value = getNumericLiteralText(delayArg, sourceFile);
            if (value) {
              const occ = getOccurrence(repoRoot, sourceFile, delayArg);
              magicOccurrences.push({
                category: "Timeouts",
                value,
                label: "socket.setTimeout (ms)",
                occurrence: occ,
              });
            }
          }
        }

        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "fs" &&
          node.expression.name.text === "chmodSync"
        ) {
          const modeArg = node.arguments[1];
          if (modeArg) {
            const value = getNumericLiteralText(modeArg, sourceFile);
            if (value) {
              const occ = getOccurrence(repoRoot, sourceFile, modeArg);
              magicOccurrences.push({
                category: "Permissions",
                value,
                label: "fs.chmodSync mode",
                occurrence: occ,
              });
            }
          }
        }
      }

      // Magic numbers: named consts
      if (ts.isVariableDeclaration(node) && node.initializer && isConstVariableDeclaration(node)) {
        const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(sourceFile);

        const numeric = getNumericLiteralText(node.initializer, sourceFile);
        if (numeric) {
          const occ = getOccurrence(repoRoot, sourceFile, node.initializer);
          const category = classifyMagicNumber(numeric, name, occ.file);
          magicOccurrences.push({ category, value: numeric, label: name, occurrence: occ });
        }

        // Include a small set of non-numeric "magic" consts (e.g., HASH_DIGEST = "sha512")
        const initUnwrapped = unwrapExpression(node.initializer);
        if (name === "HASH_DIGEST" && ts.isStringLiteralLike(initUnwrapped)) {
          const occ = getOccurrence(repoRoot, sourceFile, node.initializer);
          magicOccurrences.push({
            category: classifyMagicNumber(`"${initUnwrapped.text}"`, name, occ.file),
            value: `"${initUnwrapped.text}"`,
            label: name,
            occurrence: occ,
          });
        }
      }

      // Magic numbers: default parameter values
      if (ts.isParameter(node) && node.initializer) {
        const value = getNumericLiteralText(node.initializer, sourceFile);
        if (value) {
          const paramName = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(sourceFile);
          const occ = getOccurrence(repoRoot, sourceFile, node.initializer);
          const label = `default param \`${paramName}\``;
          const category = classifyMagicNumber(value, label, occ.file);
          magicOccurrences.push({ category, value, label, occurrence: occ });
        }
      }

      // Magic numbers: JSON-RPC error codes
      if (ts.isPropertyAssignment(node) && node.initializer) {
        let current: ts.Node | undefined = node;
        let enclosingVar: ts.VariableDeclaration | null = null;
        while (current) {
          if (ts.isVariableDeclaration(current)) {
            enclosingVar = current;
            break;
          }
          current = current.parent;
        }

        if (enclosingVar && ts.isIdentifier(enclosingVar.name) && enclosingVar.name.text === "RPC_ERRORS") {
          const value = getNumericLiteralText(node.initializer, sourceFile);
          if (value) {
            const occ = getOccurrence(repoRoot, sourceFile, node.initializer);
            const propName = node.name.getText(sourceFile).replace(/['\"]/g, "");
            magicOccurrences.push({
              category: "JSON-RPC errors",
              value,
              label: `RPC_ERRORS.${propName}`,
              occurrence: occ,
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  // Render markdown
  const lines: string[] = [];
  lines.push("# Magic Inventory");
  lines.push("");
  lines.push("Generated by `npm run inventory:magic`. Do not edit by hand.");
  lines.push("");

  // Environment variables
  lines.push("## Environment Variables");
  const envItems: InventoryItem[] = [...envVars.entries()]
    .map(([key, occurrences]) => ({
      key,
      description: describeEnvVar(key),
      occurrences,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  if (envItems.length === 0) {
    lines.push("- (none found)");
  } else {
    for (const item of envItems) {
      lines.push(`- \`${item.key}\` — ${item.description} — ${formatOccurrences(item.occurrences)}`);
    }
  }
  lines.push("");

  // Runtime paths
  lines.push("## Runtime Paths");
  const pathItems: InventoryItem[] = [...runtimePaths.entries()]
    .map(([key, v]) => ({
      key,
      description: describePath(key, v.usedDefaultDataDir),
      occurrences: v.occurrences,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const pathGroups: Array<{ title: string; predicate: (p: string) => boolean }> = [
    { title: "`~/hiboss` (default state dir)", predicate: (p) => p.startsWith("~/hiboss") },
    { title: "`~/.codex`", predicate: (p) => p.startsWith("~/.codex") },
    { title: "`~/.claude`", predicate: (p) => p.startsWith("~/.claude") },
    { title: "`prompts/` (repo templates)", predicate: (p) => p === "prompts" || p.toLowerCase().includes("/prompts") },
    { title: "Other", predicate: (_p) => true },
  ];

  const used = new Set<string>();
  for (const group of pathGroups) {
    const items = pathItems.filter((it) => !used.has(it.key) && group.predicate(it.key));
    if (items.length === 0) continue;
    lines.push(`### ${group.title}`);
    for (const item of items) {
      used.add(item.key);
      lines.push(`- \`${item.key}\` — ${item.description} — ${formatOccurrences(item.occurrences)}`);
    }
    lines.push("");
  }

  // Magic numbers/constants
  lines.push("## Magic Numbers");

  // Group by category then value.
  const byCategory = new Map<MagicCategory, Map<string, { labels: Set<string>; occurrences: Occurrence[] }>>();
  for (const m of magicOccurrences) {
    const cat = m.category;
    const catMap = byCategory.get(cat) ?? new Map();
    const existing = catMap.get(m.value) ?? { labels: new Set<string>(), occurrences: [] };
    existing.labels.add(m.label);
    existing.occurrences.push(m.occurrence);
    catMap.set(m.value, existing);
    byCategory.set(cat, catMap);
  }

  const categoryOrder: MagicCategory[] = [
    "JSON-RPC errors",
    "Timeouts",
    "Retries/backoff",
    "Limits",
    "Crypto",
    "Permissions",
    "DB/schema defaults",
    "Other",
  ];

  let wroteAnyMagic = false;
  for (const category of categoryOrder) {
    const catMap = byCategory.get(category);
    if (!catMap || catMap.size === 0) continue;
    wroteAnyMagic = true;
    lines.push(`### ${describeMagicCategory(category)}`);
    const values = [...catMap.entries()].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true }));
    for (const [value, info] of values) {
      const labels = [...info.labels].sort((a, b) => a.localeCompare(b));
      const desc = describeMagicValue(category, value, labels);
      lines.push(`- \`${value}\` — ${desc} — ${formatOccurrences(info.occurrences)}`);
    }
    lines.push("");
  }

  if (!wroteAnyMagic) {
    lines.push("- (none found)");
    lines.push("");
  }

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, `${lines.join("\n")}\n`, "utf8");
}
