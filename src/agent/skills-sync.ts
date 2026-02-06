import * as fs from "fs";
import * as path from "path";
import {
  ensureDirectory,
  hashEntry,
  listTopLevelEntries,
  removeEntry,
  replaceEntry,
} from "./skills-fs.js";
import { readManagedSkillsManifest, writeManagedSkillsManifest } from "./skills-manifest.js";
import type { ManagedSkillsManifest, SkillSourceEntry, SkillSyncResult } from "./skills-types.js";
import {
  getBundledBuiltinSkillsDir,
  getHiBossBuiltinSkillsDir,
  getHiBossSkillsDir,
  getProviderManagedSkillsManifestPath,
  getProviderSkillsDir,
  getProviderStateDir,
  isReservedHiBossSkillsName,
} from "../shared/skills-paths.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";

function collectSkillSources(params: {
  rootDir: string;
  kind: SkillSourceEntry["kind"];
  relPrefix: string;
  includeName: (name: string) => boolean;
}): SkillSourceEntry[] {
  const entries = listTopLevelEntries(params.rootDir)
    .filter((entry) => params.includeName(entry.name));

  return entries.map((entry) => ({
    name: entry.name,
    absolutePath: entry.absolutePath,
    relativePath: `${params.relPrefix}${entry.name}`,
    kind: params.kind,
    hash: hashEntry(entry.absolutePath),
  }));
}

function ensureHiBossSkillRoots(hibossDir: string): { skillsDir: string; builtinDir: string } {
  const skillsDir = getHiBossSkillsDir(hibossDir);
  const builtinDir = getHiBossBuiltinSkillsDir(hibossDir);

  ensureDirectory(skillsDir);
  ensureDirectory(builtinDir);
  return { skillsDir, builtinDir };
}

function seedBuiltinsFromPackage(hibossDir: string): { warnings: string[] } {
  const warnings: string[] = [];
  const { builtinDir } = ensureHiBossSkillRoots(hibossDir);
  const sourceDir = getBundledBuiltinSkillsDir();

  if (!sourceDir || !fs.existsSync(sourceDir)) {
    const message = sourceDir
      ? `Built-in skills source not found: ${sourceDir}`
      : "Built-in skills source path is unavailable";
    warnings.push(message);
    logEvent("warn", "skills-builtins-source-missing", {
      "hiboss-dir": hibossDir,
      "source-dir": sourceDir ?? "unknown",
      message,
    });
    return { warnings };
  }

  const sourceEntries = listTopLevelEntries(sourceDir);
  const runId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingDir = `${builtinDir}.seed-${runId}`;
  const oldDir = `${builtinDir}.old-${runId}`;
  ensureDirectory(stagingDir);

  try {
    for (const sourceEntry of sourceEntries) {
      replaceEntry(sourceEntry.absolutePath, path.join(stagingDir, sourceEntry.name));
    }

    if (fs.existsSync(builtinDir)) {
      fs.renameSync(builtinDir, oldDir);
    }
    fs.renameSync(stagingDir, builtinDir);
    if (fs.existsSync(oldDir)) {
      removeEntry(oldDir);
    }
  } catch (err) {
    if (fs.existsSync(stagingDir)) {
      removeEntry(stagingDir);
    }
    if (!fs.existsSync(builtinDir) && fs.existsSync(oldDir)) {
      try {
        fs.renameSync(oldDir, builtinDir);
      } catch {
        // best-effort rollback
      }
    }
    const message = errorMessage(err);
    warnings.push(`Built-in skill re-seed failed: ${message}`);
    logEvent("warn", "skills-builtins-seed-failed", {
      "hiboss-dir": hibossDir,
      error: message,
    });
    return { warnings };
  }

  logEvent("info", "skills-builtins-seeded", {
    "hiboss-dir": hibossDir,
    "source-dir": sourceDir,
    count: sourceEntries.length,
  });

  return { warnings };
}

function buildDesiredManagedSources(hibossDir: string): Map<string, SkillSourceEntry> {
  const builtinDir = getHiBossBuiltinSkillsDir(hibossDir);
  const skillsDir = getHiBossSkillsDir(hibossDir);

  const builtinEntries = collectSkillSources({
    rootDir: builtinDir,
    kind: "builtin",
    relPrefix: ".system/",
    includeName: (name) => !name.startsWith("."),
  });

  const globalEntries = collectSkillSources({
    rootDir: skillsDir,
    kind: "global",
    relPrefix: "",
    includeName: (name) => !name.startsWith(".") && !isReservedHiBossSkillsName(name),
  });

  const byName = new Map<string, SkillSourceEntry>();
  for (const entry of builtinEntries) {
    byName.set(entry.name, entry);
  }
  for (const entry of globalEntries) {
    byName.set(entry.name, entry);
  }
  return byName;
}

function normalizeManifestEntries(
  entries: ManagedSkillsManifest["entries"]
): ManagedSkillsManifest["entries"] {
  return Object.fromEntries(
    Object.entries(entries).filter(([name, entry]) => {
      return Boolean(name && !name.startsWith(".") && entry.targetRelPath === name);
    })
  );
}

export function syncProviderSkillsForNewSession(params: {
  hibossDir: string;
  agentName: string;
  provider: "claude" | "codex";
  providerHomePath: string;
}): SkillSyncResult {
  const stats = { added: 0, updated: 0, removed: 0, skippedPrivate: 0 };
  const warnings: string[] = [];

  try {
    const seeded = seedBuiltinsFromPackage(params.hibossDir);
    warnings.push(...seeded.warnings);

    const desiredByName = buildDesiredManagedSources(params.hibossDir);

    const providerSkillsDir = getProviderSkillsDir(params.providerHomePath);
    const providerStateDir = getProviderStateDir(params.providerHomePath);
    const manifestPath = getProviderManagedSkillsManifestPath(params.providerHomePath);

    ensureDirectory(providerSkillsDir);
    ensureDirectory(providerStateDir);

    const existingManifest = readManagedSkillsManifest(manifestPath);
    const priorEntries = normalizeManifestEntries(existingManifest?.entries ?? {});

    const providerEntries = listTopLevelEntries(providerSkillsDir)
      .filter((entry) => !entry.name.startsWith("."));

    const providerByName = new Map(providerEntries.map((entry) => [entry.name, entry]));
    const nextEntries: ManagedSkillsManifest["entries"] = {};

    for (const [name] of Object.entries(priorEntries)) {
      if (!desiredByName.has(name)) {
        const existing = providerByName.get(name);
        if (existing) {
          removeEntry(existing.absolutePath);
          stats.removed += 1;
        }
      }
    }

    for (const [name, source] of desiredByName.entries()) {
      const targetPath = path.join(providerSkillsDir, name);
      const providerEntry = providerByName.get(name);
      const priorManaged = priorEntries[name];

      if (providerEntry && !priorManaged) {
        const currentHash = hashEntry(providerEntry.absolutePath);
        if (currentHash === source.hash) {
          nextEntries[name] = {
            sourceKind: source.kind,
            sourceRelPath: source.relativePath,
            sourceHash: source.hash,
            targetRelPath: name,
          };
          continue;
        }

        stats.skippedPrivate += 1;
        logEvent("warn", "skills-sync-skip-private", {
          "agent-name": params.agentName,
          provider: params.provider,
          "skill-name": name,
          "source-kind": source.kind,
          reason: "private-precedence",
        });
        continue;
      }

      if (!providerEntry) {
        replaceEntry(source.absolutePath, targetPath);
        stats.added += 1;
      } else {
        const currentHash = hashEntry(providerEntry.absolutePath);
        if (currentHash !== source.hash) {
          if (priorManaged && priorManaged.sourceHash === source.hash) {
            logEvent("warn", "skills-managed-overwrite", {
              "agent-name": params.agentName,
              provider: params.provider,
              "skill-name": name,
              reason: "provider-home-drift",
            });
          }
          replaceEntry(source.absolutePath, targetPath);
          stats.updated += 1;
        }
      }

      nextEntries[name] = {
        sourceKind: source.kind,
        sourceRelPath: source.relativePath,
        sourceHash: source.hash,
        targetRelPath: name,
      };
    }

    writeManagedSkillsManifest(manifestPath, nextEntries);

    logEvent("info", "skills-sync-provider-complete", {
      "agent-name": params.agentName,
      provider: params.provider,
      added: stats.added,
      updated: stats.updated,
      removed: stats.removed,
      "skipped-private": stats.skippedPrivate,
      warnings: warnings.length,
    });
  } catch (err) {
    const message = errorMessage(err);
    warnings.push(message);
    logEvent("warn", "skills-sync-provider-failed", {
      "agent-name": params.agentName,
      provider: params.provider,
      error: message,
    });
  }

  return { stats, warnings };
}
