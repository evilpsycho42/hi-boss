import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

type Occurrence = { file: string; line: number };

type InventoryItem = {
  key: string;
  description: string;
  occurrences: Occurrence[];
};

type MagicCategory =
  | "JSON-RPC errors"
  | "Timeouts"
  | "Retries/backoff"
  | "Limits"
  | "Crypto"
  | "Permissions"
  | "DB/schema defaults"
  | "Other";

type MagicOccurrence = {
  category: MagicCategory;
  value: string;
  label: string;
  occurrence: Occurrence;
};

function parseArgs(argv: string[]): { outPath: string } {
  const outIndex = argv.indexOf("--out");
  if (outIndex === -1) return { outPath: "docs/spec/generated/magic-inventory.md" };
  const outPath = argv[outIndex + 1];
  if (!outPath) {
    throw new Error("Missing value for --out (expected a filepath)");
  }
  return { outPath };
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

function formatOccurrences(occurrences: Occurrence[]): string {
  const uniq = new Map<string, Occurrence>();
  for (const occ of occurrences) {
    uniq.set(`${occ.file}:${occ.line}`, occ);
  }
  const sorted = [...uniq.values()].sort((a, b) =>
    `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`)
  );
  return sorted.map((o) => `\`${o.file}:${o.line}\``).join(", ");
}

function camelToKebab(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function makePlaceholder(name: string): string {
  const kebab = camelToKebab(name);
  return kebab.length > 0 ? `<${kebab}>` : "<dynamic>";
}

function getOccurrence(
  repoRoot: string,
  sourceFile: ts.SourceFile,
  node: ts.Node
): Occurrence {
  const rel = toPosixPath(path.relative(repoRoot, sourceFile.fileName));
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file: rel, line: line + 1 };
}

function isConstVariableDeclaration(decl: ts.VariableDeclaration): boolean {
  const list = decl.parent;
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
}

function isProcessEnv(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "env" &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "process"
  );
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expr)) return unwrapExpression(expr.expression);
  if (ts.isAsExpression(expr)) return unwrapExpression(expr.expression);
  if (ts.isTypeAssertionExpression(expr)) return unwrapExpression(expr.expression);
  if (ts.isNonNullExpression(expr)) return unwrapExpression(expr.expression);
  return expr;
}

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function resolveConstString(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  depth = 0,
  seen = new Set<ts.Symbol>()
): string | null {
  if (depth > 20) return null;
  const unwrapped = unwrapExpression(expr);

  if (ts.isStringLiteralLike(unwrapped)) return unwrapped.text;

  if (ts.isIdentifier(unwrapped)) {
    const symbolAtLoc = checker.getSymbolAtLocation(unwrapped);
    if (!symbolAtLoc) return null;
    const symbol = resolveAliasedSymbol(checker, symbolAtLoc);
    if (seen.has(symbol)) return null;
    seen.add(symbol);

    for (const decl of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(decl) && decl.initializer && isConstVariableDeclaration(decl)) {
        const v = resolveConstString(checker, decl.initializer, depth + 1, seen);
        if (v !== null) return v;
      }
      if (ts.isEnumMember(decl) && decl.initializer) {
        const v = resolveConstString(checker, decl.initializer, depth + 1, seen);
        if (v !== null) return v;
      }
    }
    return null;
  }

  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveConstString(checker, unwrapped.left, depth + 1, seen);
    const right = resolveConstString(checker, unwrapped.right, depth + 1, seen);
    if (left === null || right === null) return null;
    return left + right;
  }

  return null;
}

type PathEval = {
  text: string;
  usedDefaultDataDir: boolean;
  usedDefaultHiBossDir: boolean;
};

function joinPosix(parts: string[]): string {
  const cleaned = parts
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/\\/g, "/"));
  return cleaned.join("/").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function evaluatePathExpression(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  depth = 0,
  seen = new Set<ts.Symbol>()
): PathEval | null {
  if (depth > 25) return null;
  const unwrapped = unwrapExpression(expr);

  if (ts.isStringLiteralLike(unwrapped))
    return { text: unwrapped.text, usedDefaultDataDir: false, usedDefaultHiBossDir: false };

  if (ts.isIdentifier(unwrapped)) {
    if (unwrapped.text === "__dirname")
      return { text: "<module-dir>", usedDefaultDataDir: false, usedDefaultHiBossDir: false };
    if (unwrapped.text === "__filename")
      return { text: "<module-file>", usedDefaultDataDir: false, usedDefaultHiBossDir: false };

    const symbolAtLoc = checker.getSymbolAtLocation(unwrapped);
    if (!symbolAtLoc)
      return { text: makePlaceholder(unwrapped.text), usedDefaultDataDir: false, usedDefaultHiBossDir: false };
    const symbol = resolveAliasedSymbol(checker, symbolAtLoc);
    if (seen.has(symbol))
      return { text: makePlaceholder(unwrapped.text), usedDefaultDataDir: false, usedDefaultHiBossDir: false };
    seen.add(symbol);

    for (const decl of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(decl) && decl.initializer && isConstVariableDeclaration(decl)) {
        const v = evaluatePathExpression(checker, decl.initializer, sourceFile, depth + 1, seen);
        if (v) return v;
      }
    }

    return { text: makePlaceholder(unwrapped.text), usedDefaultDataDir: false, usedDefaultHiBossDir: false };
  }

  if (ts.isPropertyAccessExpression(unwrapped)) {
    if (unwrapped.name.text === "dataDir") {
      return { text: "~/hiboss", usedDefaultDataDir: true, usedDefaultHiBossDir: false };
    }
    if (unwrapped.name.text === "daemonDir") {
      return { text: "~/hiboss/.daemon", usedDefaultDataDir: true, usedDefaultHiBossDir: false };
    }
    const raw = unwrapped.getText(sourceFile);
    return { text: makePlaceholder(raw), usedDefaultDataDir: false, usedDefaultHiBossDir: false };
  }

  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    const left = evaluatePathExpression(checker, unwrapped.left, sourceFile, depth + 1, seen);
    const right = evaluatePathExpression(checker, unwrapped.right, sourceFile, depth + 1, seen);
    if (right && (!left || left.text.startsWith("<"))) return right;
    return left ?? right;
  }

  if (ts.isCallExpression(unwrapped)) {
    const callee = unwrapped.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = callee.expression;
      const method = callee.name.text;

      if (ts.isIdentifier(receiver) && receiver.text === "os" && method === "homedir") {
        return { text: "~", usedDefaultDataDir: false, usedDefaultHiBossDir: false };
      }

      if (ts.isIdentifier(receiver) && receiver.text === "path" && (method === "join" || method === "resolve")) {
        const parts: string[] = [];
        let usedDefaultDataDir = false;
        let usedDefaultHiBossDir = false;
        for (const arg of unwrapped.arguments) {
          const evaluated = evaluatePathExpression(checker, arg, sourceFile, depth + 1, seen);
          if (!evaluated) return null;
          if (evaluated.usedDefaultDataDir) usedDefaultDataDir = true;
          if (evaluated.usedDefaultHiBossDir) usedDefaultHiBossDir = true;
          parts.push(evaluated.text);
        }
        const merged = joinPosix(parts);
        const text = merged.startsWith("~/") ? merged : merged.replace(/^~\/\//, "~/");
        return { text, usedDefaultDataDir, usedDefaultHiBossDir };
      }
    }

    if (ts.isIdentifier(callee)) {
      const fn = callee.text;
      if (fn === "getHiBossDir") {
        return { text: "~/hiboss", usedDefaultDataDir: false, usedDefaultHiBossDir: true };
      }
      if (fn === "getSocketPath") {
        return { text: "~/hiboss/.daemon/daemon.sock", usedDefaultDataDir: true, usedDefaultHiBossDir: false };
      }
      if (fn === "getAgentDir") {
        const agentNameExpr = unwrapped.arguments[0];
        const agentName = agentNameExpr
          ? evaluatePathExpression(checker, agentNameExpr, sourceFile, depth + 1, seen)?.text ?? "<agent-name>"
          : "<agent-name>";
        return {
          text: joinPosix(["~/hiboss", "agents", agentName]),
          usedDefaultDataDir: false,
          usedDefaultHiBossDir: true,
        };
      }
      if (fn === "getCodexHomePath") {
        const agentNameExpr = unwrapped.arguments[0];
        const agentName = agentNameExpr
          ? evaluatePathExpression(checker, agentNameExpr, sourceFile, depth + 1, seen)?.text ?? "<agent-name>"
          : "<agent-name>";
        return {
          text: joinPosix(["~/hiboss", "agents", agentName, "codex_home"]),
          usedDefaultDataDir: false,
          usedDefaultHiBossDir: true,
        };
      }
      if (fn === "getClaudeHomePath") {
        const agentNameExpr = unwrapped.arguments[0];
        const agentName = agentNameExpr
          ? evaluatePathExpression(checker, agentNameExpr, sourceFile, depth + 1, seen)?.text ?? "<agent-name>"
          : "<agent-name>";
        return {
          text: joinPosix(["~/hiboss", "agents", agentName, "claude_home"]),
          usedDefaultDataDir: false,
          usedDefaultHiBossDir: true,
        };
      }
      if (fn === "findUp") {
        return { text: "<repo-root>", usedDefaultDataDir: false, usedDefaultHiBossDir: false };
      }
    }

    const calleeText = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : "call";
    return { text: makePlaceholder(calleeText), usedDefaultDataDir: false, usedDefaultHiBossDir: false };
  }

  if (ts.isTemplateExpression(unwrapped)) {
    return { text: makePlaceholder("template"), usedDefaultDataDir: false, usedDefaultHiBossDir: false };
  }

  return null;
}

function isInterestingRuntimePath(p: string): boolean {
  const lower = p.toLowerCase();
  if (p.startsWith("~/hiboss")) return true;
  if (p.startsWith("~/.codex")) return true;
  if (p.startsWith("~/.claude")) return true;
  if (lower.includes("log_history") || lower.endsWith("/log_history")) return true;
  if (lower.includes("/prompts") || lower.endsWith("/prompts") || lower === "prompts") return true;
  if (lower.includes("test-save")) return true;
  if (lower.includes("codex_home") || lower.includes("claude_home")) return true;
  if (
    lower.endsWith(".db") ||
    lower.endsWith(".sock") ||
    lower.endsWith(".pid") ||
    lower.endsWith(".log") ||
    lower.endsWith(".toml") ||
    lower.endsWith(".json") ||
    lower.endsWith(".md")
  ) {
    return true;
  }
  return false;
}

function describeEnvVar(name: string): string {
  if (name === "HIBOSS_TOKEN") return "agent token (auth; CLI default)";
  return "environment variable";
}

function describePath(p: string, usedDefaultDataDir: boolean): string {
  const dataDirNote = usedDefaultDataDir ? " (under dataDir; default `~/hiboss`)" : "";
  if (p === "~/hiboss") return "Hi-Boss state directory (default)";
  if (p.startsWith("~/hiboss/")) {
    if (p.endsWith("/.daemon")) return `daemon internal directory${dataDirNote}`;
    if (p.endsWith("/.daemon/hiboss.db")) return `SQLite database file${dataDirNote}`;
    if (p.endsWith("/.daemon/daemon.sock")) return `IPC socket file${dataDirNote}`;
    if (p.endsWith("/.daemon/daemon.pid")) return `daemon PID file${dataDirNote}`;
    if (p.endsWith("/.daemon/daemon.log")) return `daemon log file${dataDirNote}`;
    if (p.endsWith("/.daemon/log_history")) return `daemon log history directory${dataDirNote}`;
    if (p.endsWith("/media")) return "Telegram media download directory";
    if (p.includes("/agents/") && p.includes("/codex_home")) return "agent Codex home directory";
    if (p.includes("/agents/") && p.includes("/claude_home")) return "agent Claude home directory";
    if (p.includes("/agents/")) return "agent state directory";
  }
  if (p.startsWith("~/.codex/")) return "Codex user config (copied into agent home)";
  if (p.startsWith("~/.claude/")) return "Claude user config (copied into agent home)";
  if (p.endsWith("/prompts") || p === "prompts") return "repo prompt templates directory";
  if (p.includes("/envelope/") && p.endsWith(".md")) return "prompt template";
  if (p.toLowerCase().includes("test-save")) return "bot attachment save directory (dev/test)";
  return "runtime path";
}

function getNumericLiteralText(node: ts.Expression, sourceFile: ts.SourceFile): string | null {
  const unwrapped = unwrapExpression(node);
  if (ts.isNumericLiteral(unwrapped)) return unwrapped.getText(sourceFile);
  if (
    ts.isPrefixUnaryExpression(unwrapped) &&
    (unwrapped.operator === ts.SyntaxKind.MinusToken || unwrapped.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(unwrapped.operand)
  ) {
    return unwrapped.getText(sourceFile);
  }
  return null;
}

function classifyMagicNumber(valueText: string, label: string, file: string): MagicCategory {
  if (file.endsWith("src/daemon/ipc/types.ts")) return "JSON-RPC errors";
  if (valueText.startsWith("0o")) return "Permissions";
  if (file.endsWith("src/agent/auth.ts") || label.startsWith("HASH_") || label.startsWith("SALT_")) return "Crypto";
  if (file.endsWith("src/adapters/telegram.adapter.ts")) return "Retries/backoff";
  if (/retry|backoff|jitter|factor|maxretries/i.test(label)) return "Retries/backoff";
  if (/timeout|interval|_ms$/i.test(label) || label.includes("setTimeout") || label.includes("setInterval"))
    return "Timeouts";
  if (/max|limit/i.test(label) || label.includes("default param")) return "Limits";
  return "Other";
}

function describeMagicCategory(category: MagicCategory): string {
  return category;
}

function describeMagicValue(category: MagicCategory, value: string, labels: string[]): string {
  const labelText = labels.length > 0 ? labels.join("; ") : "magic value";
  if (category === "JSON-RPC errors") return labelText;
  if (category === "DB/schema defaults") return labelText;
  return labelText;
}

function extractSchemaDefaults(repoRoot: string): MagicOccurrence[] {
  const schemaFile = path.join(repoRoot, "src/daemon/db/schema.ts");
  if (!fs.existsSync(schemaFile)) return [];

  const relFile = toPosixPath(path.relative(repoRoot, schemaFile));
  const lines = fs.readFileSync(schemaFile, "utf8").split(/\r?\n/);

  let currentTable: string | null = null;
  const occurrences: MagicOccurrence[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const tableMatch = line.match(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/i);
    if (tableMatch) {
      currentTable = tableMatch[1];
      continue;
    }

    if (!line.includes("DEFAULT")) continue;

    const match = line.match(/^\s*([^\s,]+)\s+.*?\bDEFAULT\b\s+([^,\n]+?)(?:,|\s--|$)/);
    if (!match) continue;

    const column = match[1].replace(/\"/g, "");
    const defaultValue = match[2].trim();
    const columnRef = currentTable ? `${currentTable}.${column}` : column;

    occurrences.push({
      category: "DB/schema defaults",
      value: defaultValue,
      label: columnRef,
      occurrence: { file: relFile, line: i + 1 },
    });
  }

  return occurrences;
}

function main(): void {
  const { outPath } = parseArgs(process.argv.slice(2));
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

main();
