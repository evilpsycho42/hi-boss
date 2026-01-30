import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_MEMORY_LONGTERM_MAX_CHARS,
  DEFAULT_MEMORY_SHORTTERM_DAYS,
  DEFAULT_MEMORY_SHORTTERM_MAX_CHARS,
  DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS,
  DEFAULT_MEMORY_TOTAL_MAX_CHARS,
} from "./defaults.js";
import { assertValidAgentName } from "./validation.js";

export const MAX_MEMORY_TOTAL_CHARS = DEFAULT_MEMORY_TOTAL_MAX_CHARS;
export const MAX_LONGTERM_CHARS = DEFAULT_MEMORY_LONGTERM_MAX_CHARS;
export const MAX_SHORTTERM_TOTAL_CHARS = DEFAULT_MEMORY_SHORTTERM_MAX_CHARS;
export const MAX_SHORTTERM_PER_DAY_CHARS = DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS;
export const MAX_SHORTTERM_DAYS = DEFAULT_MEMORY_SHORTTERM_DAYS;

const DAILY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getAgentMemoryDir(hibossDir: string, agentName: string): string {
  return path.join(hibossDir, "agents", agentName, "memory");
}

function getAgentDailyDir(hibossDir: string, agentName: string): string {
  return path.join(getAgentMemoryDir(hibossDir, agentName), "daily");
}

function truncateWithMarker(input: string, maxChars: number, marker: string): string {
  if (input.length <= maxChars) return input;
  const trimmed = input.slice(0, maxChars);
  return `${trimmed}\n\n${marker}`;
}

export function ensureAgentMemoryLayout(params: {
  hibossDir: string;
  agentName: string;
}): { ok: true } | { ok: false; error: string } {
  try {
    assertValidAgentName(params.agentName);

    const memoryDir = getAgentMemoryDir(params.hibossDir, params.agentName);
    const dailyDir = getAgentDailyDir(params.hibossDir, params.agentName);
    const memoryPath = path.join(memoryDir, "MEMORY.md");

    fs.mkdirSync(dailyDir, { recursive: true });

    if (!fs.existsSync(memoryPath)) {
      fs.writeFileSync(memoryPath, "", "utf8");
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

function listRecentDailyFiles(dailyDir: string, days: number): string[] {
  if (!fs.existsSync(dailyDir)) return [];

  const entries = fs.readdirSync(dailyDir).filter((name) => DAILY_FILE_RE.test(name)).sort();
  if (entries.length === 0) return [];

  const slice = days > 0 ? entries.slice(-days) : [];
  return slice.map((name) => path.join(dailyDir, name));
}

export function readAgentMemorySnapshot(params: {
  hibossDir: string;
  agentName: string;
}):
  | { ok: true; longterm: string; shortterm: string }
  | { ok: false; error: string } {
  try {
    assertValidAgentName(params.agentName);

    const memoryDir = getAgentMemoryDir(params.hibossDir, params.agentName);
    const dailyDir = getAgentDailyDir(params.hibossDir, params.agentName);
    const memoryPath = path.join(memoryDir, "MEMORY.md");

    let longtermRaw = "";
    if (fs.existsSync(memoryPath)) {
      const stat = fs.statSync(memoryPath);
      if (stat.isFile()) {
        longtermRaw = fs.readFileSync(memoryPath, "utf8");
      }
    }

    const longterm = truncateWithMarker(
      longtermRaw.trim(),
      MAX_LONGTERM_CHARS,
      `<<truncated due to longterm-max-chars=${MAX_LONGTERM_CHARS}>>`
    );

    const dailyFiles = listRecentDailyFiles(dailyDir, MAX_SHORTTERM_DAYS);
    let shorttermCombined = "";

    for (const filePath of dailyFiles) {
      const name = path.basename(filePath);
      let contents = "";
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          contents = fs.readFileSync(filePath, "utf8");
        }
      } catch {
        // Skip unreadable daily files (best-effort).
        continue;
      }

      const body = truncateWithMarker(
        contents.trim(),
        MAX_SHORTTERM_PER_DAY_CHARS,
        `<<truncated due to shortterm-per-day-max-chars=${MAX_SHORTTERM_PER_DAY_CHARS}>>`
      );

      shorttermCombined += `# daily/${name}\n${body}\n\n`;
    }

    shorttermCombined = shorttermCombined.trim();

    const shortterm = truncateWithMarker(
      shorttermCombined,
      MAX_SHORTTERM_TOTAL_CHARS,
      `<<truncated due to shortterm-max-chars=${MAX_SHORTTERM_TOTAL_CHARS}>>`
    );

    return { ok: true, longterm, shortterm };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}
