export type SkillSourceKind = "builtin" | "global";

export interface SkillSourceEntry {
  name: string;
  absolutePath: string;
  relativePath: string;
  kind: SkillSourceKind;
  hash: string;
}

export interface ManagedSkillEntry {
  sourceKind: SkillSourceKind;
  sourceRelPath: string;
  sourceHash: string;
  targetRelPath: string;
}

export interface ManagedSkillsManifest {
  version: 1;
  generatedAt: string;
  entries: Record<string, ManagedSkillEntry>;
}

export interface SkillSyncStats {
  added: number;
  updated: number;
  removed: number;
  skippedPrivate: number;
}

export interface SkillSyncResult {
  stats: SkillSyncStats;
  warnings: string[];
}

