import * as fs from "fs";
import { writeJsonFileAtomic } from "./skills-fs.js";
import type { ManagedSkillsManifest } from "./skills-types.js";

export function readManagedSkillsManifest(manifestPath: string): ManagedSkillsManifest | null {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    if (raw.version !== 1) {
      return null;
    }

    const entriesRaw = raw.entries;
    if (typeof entriesRaw !== "object" || entriesRaw === null || Array.isArray(entriesRaw)) {
      return null;
    }

    const entries: ManagedSkillsManifest["entries"] = {};
    for (const [name, value] of Object.entries(entriesRaw as Record<string, unknown>)) {
      if (!name || name.startsWith(".")) continue;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const v = value as Record<string, unknown>;

      if ((v.sourceKind !== "builtin" && v.sourceKind !== "global") ||
        typeof v.sourceRelPath !== "string" ||
        typeof v.sourceHash !== "string" ||
        typeof v.targetRelPath !== "string") {
        continue;
      }

      entries[name] = {
        sourceKind: v.sourceKind,
        sourceRelPath: v.sourceRelPath,
        sourceHash: v.sourceHash,
        targetRelPath: v.targetRelPath,
      };
    }

    return {
      version: 1,
      generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : new Date(0).toISOString(),
      entries,
    };
  } catch {
    return null;
  }
}

export function writeManagedSkillsManifest(
  manifestPath: string,
  entries: ManagedSkillsManifest["entries"]
): void {
  const value: ManagedSkillsManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries,
  };
  writeJsonFileAtomic(manifestPath, value);
}

