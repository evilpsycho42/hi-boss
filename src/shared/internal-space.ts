import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_MEMORY_LONGTERM_MAX_CHARS,
  DEFAULT_MEMORY_SHORTTERM_DAYS,
  DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS,
} from "./defaults.js";
import { assertValidAgentName } from "./validation.js";

const MEMORY_FILENAME = "MEMORY.md";
const LEGACY_NOTE_FILENAME = "Note.md";
const DAILY_MEMORIES_DIRNAME = "memories";
const DAILY_MEMORY_FILENAME_REGEX = /^\d{4}-\d{2}-\d{2}\.md$/;

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getAgentInternalSpaceDir(hibossDir: string, agentName: string): string {
  return path.join(hibossDir, "agents", agentName, "internal_space");
}

function getAgentMemoryPath(hibossDir: string, agentName: string): string {
  return path.join(getAgentInternalSpaceDir(hibossDir, agentName), MEMORY_FILENAME);
}

function getAgentDailyMemoriesDir(hibossDir: string, agentName: string): string {
  return path.join(getAgentInternalSpaceDir(hibossDir, agentName), DAILY_MEMORIES_DIRNAME);
}

function truncateWithMarker(input: string, maxChars: number, marker: string): string {
  if (input.length <= maxChars) return input;
  const trimmed = input.slice(0, maxChars);
  return `${trimmed}\n\n${marker}`;
}

export function ensureAgentInternalSpaceLayout(params: {
  hibossDir: string;
  agentName: string;
}): { ok: true } | { ok: false; error: string } {
  try {
    assertValidAgentName(params.agentName);

    const dir = getAgentInternalSpaceDir(params.hibossDir, params.agentName);
    const memoryPath = getAgentMemoryPath(params.hibossDir, params.agentName);
    const legacyNotePath = path.join(dir, LEGACY_NOTE_FILENAME);

    fs.mkdirSync(dir, { recursive: true });

    const dailyDir = getAgentDailyMemoriesDir(params.hibossDir, params.agentName);
    fs.mkdirSync(dailyDir, { recursive: true });
    if (fs.existsSync(dailyDir) && !fs.statSync(dailyDir).isDirectory()) {
      return { ok: false, error: `Expected directory at ${dailyDir}` };
    }

    if (!fs.existsSync(memoryPath)) {
      // Best-effort migration from legacy Note.md -> MEMORY.md
      if (fs.existsSync(legacyNotePath)) {
        try {
          const stat = fs.statSync(legacyNotePath);
          if (stat.isFile()) {
            fs.renameSync(legacyNotePath, memoryPath);
          }
        } catch {
          // Fall back to creating an empty file.
        }
      }
      if (!fs.existsSync(memoryPath)) {
        fs.writeFileSync(memoryPath, "", "utf8");
      }
    } else {
      const stat = fs.statSync(memoryPath);
      if (!stat.isFile()) {
        return { ok: false, error: `Expected file at ${memoryPath}` };
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

export function readAgentInternalMemorySnapshot(params: {
  hibossDir: string;
  agentName: string;
}):
  | { ok: true; note: string }
  | { ok: false; error: string } {
  try {
    assertValidAgentName(params.agentName);

    const memoryPath = getAgentMemoryPath(params.hibossDir, params.agentName);

    let raw = "";
    if (fs.existsSync(memoryPath)) {
      const stat = fs.statSync(memoryPath);
      if (stat.isFile()) {
        raw = fs.readFileSync(memoryPath, "utf8");
      }
    }

    const note = truncateWithMarker(
      raw.trim(),
      DEFAULT_MEMORY_LONGTERM_MAX_CHARS,
      `<<truncated due to internal-space-memory-max-chars=${DEFAULT_MEMORY_LONGTERM_MAX_CHARS}>>`
    );

    return { ok: true, note };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

export function readAgentInternalDailyMemorySnapshot(params: {
  hibossDir: string;
  agentName: string;
}):
  | { ok: true; note: string }
  | { ok: false; error: string } {
  try {
    assertValidAgentName(params.agentName);

    const dailyMaxChars = DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS * DEFAULT_MEMORY_SHORTTERM_DAYS;

    const dailyDir = getAgentDailyMemoriesDir(params.hibossDir, params.agentName);
    if (!fs.existsSync(dailyDir)) {
      return { ok: true, note: "" };
    }
    const stat = fs.statSync(dailyDir);
    if (!stat.isDirectory()) {
      return { ok: false, error: `Expected directory at ${dailyDir}` };
    }

    const candidateFiles = fs
      .readdirSync(dailyDir)
      .filter((name) => DAILY_MEMORY_FILENAME_REGEX.test(name))
      .sort()
      .reverse()
      .slice(0, DEFAULT_MEMORY_SHORTTERM_DAYS);

    const blocks: string[] = [];
    for (const filename of candidateFiles) {
      const filePath = path.join(dailyDir, filename);
      try {
        const fileStat = fs.statSync(filePath);
        if (!fileStat.isFile()) continue;
        const raw = fs.readFileSync(filePath, "utf8").trim();
        if (!raw) continue;
        const truncated = truncateWithMarker(
          raw,
          DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS,
          `<<truncated due to internal-space-daily-per-day-max-chars=${DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS}>>`
        );
        blocks.push(`--- ${filename.replace(/\.md$/, "")} ---\n${truncated}`);
      } catch {
        // Best-effort: skip unreadable daily files.
      }
    }

    const combinedRaw = blocks.join("\n\n");
    const combined = truncateWithMarker(
      combinedRaw,
      dailyMaxChars,
      `<<truncated due to internal-space-daily-max-chars=${dailyMaxChars}>>`
    );

    return { ok: true, note: combined };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}
