import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type CodexLastTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  modelContextWindow?: number;
};

const CODEX_ROLLOUT_PATH_CACHE: Map<string, string> = new Map();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getDefaultCodexSessionsDir(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

export async function findCodexRolloutPathForThread(threadId: string): Promise<string | null> {
  const cached = CODEX_ROLLOUT_PATH_CACHE.get(threadId);
  if (cached) {
    try {
      const stat = await fs.stat(cached);
      if (stat.isFile()) return cached;
    } catch {
      CODEX_ROLLOUT_PATH_CACHE.delete(threadId);
    }
  }

  const sessionsDir = getDefaultCodexSessionsDir();
  const candidateDirs: string[] = [];
  const now = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const year = String(d.getFullYear());
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    candidateDirs.push(path.join(sessionsDir, year, month, day));
  }

  const matches: { fullPath: string; mtimeMs: number }[] = [];

  const scanDirForMatches = async (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("rollout-")) continue;
      if (!entry.name.endsWith(".jsonl")) continue;
      if (!entry.name.includes(threadId)) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;
        matches.push({ fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // ignore
      }
    }
  };

  for (const dir of candidateDirs) {
    await scanDirForMatches(dir);
  }

  if (matches.length === 0) {
    // Fallback: scan the whole sessions directory tree (best-effort).
    const scanLevel = async (dir: string, depth: number) => {
      if (depth < 0) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanLevel(fullPath, depth - 1);
        } else if (entry.isFile()) {
          if (!entry.name.startsWith("rollout-")) continue;
          if (!entry.name.endsWith(".jsonl")) continue;
          if (!entry.name.includes(threadId)) continue;
          try {
            const stat = await fs.stat(fullPath);
            if (!stat.isFile()) continue;
            matches.push({ fullPath, mtimeMs: stat.mtimeMs });
          } catch {
            // ignore
          }
        }
      }
    };

    await scanLevel(sessionsDir, 3);
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const best = matches[0]!.fullPath;
  CODEX_ROLLOUT_PATH_CACHE.set(threadId, best);
  return best;
}

export async function readCodexFinalCallTokenUsageFromRollout(
  rolloutPath: string
): Promise<CodexLastTokenUsage | null> {
  // Search backwards from the end: find the last `event_msg` token_count entry.
  let file: fs.FileHandle | null = null;
  try {
    file = await fs.open(rolloutPath, "r");
    const stat = await file.stat();
    const size = stat.size;
    if (size <= 0) return null;

    const initialTailBytes = 256 * 1024;
    const maxTailBytes = 8 * 1024 * 1024;
    let tailBytes = Math.min(size, initialTailBytes);

    while (tailBytes > 0) {
      const start = Math.max(0, size - tailBytes);
      const buffer = Buffer.alloc(tailBytes);
      const { bytesRead } = await file.read(buffer, 0, tailBytes, start);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = (lines[i] ?? "").trim();
        if (!line) continue;
        if (!line.includes("token_count")) continue;

        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (!isRecord(event)) continue;
        if (event.type !== "event_msg") continue;

        const payload = event.payload;
        if (!isRecord(payload)) continue;
        if (payload.type !== "token_count") continue;

        const info = payload.info;
        if (!isRecord(info)) continue;

        const lastUsage = info.last_token_usage;
        if (!isRecord(lastUsage)) continue;

        const inputTokens = asFiniteNumber(lastUsage.input_tokens);
        const cachedInputTokens = asFiniteNumber(lastUsage.cached_input_tokens);
        const outputTokens = asFiniteNumber(lastUsage.output_tokens);
        const reasoningOutputTokens = asFiniteNumber(lastUsage.reasoning_output_tokens);
        const totalTokens = asFiniteNumber(lastUsage.total_tokens);
        const modelContextWindow = asFiniteNumber(info.model_context_window);

        if (
          inputTokens === null ||
          cachedInputTokens === null ||
          outputTokens === null ||
          reasoningOutputTokens === null ||
          totalTokens === null
        ) {
          continue;
        }

        return {
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningOutputTokens,
          totalTokens,
          ...(modelContextWindow !== null ? { modelContextWindow } : {}),
        };
      }

      if (tailBytes >= size) break;
      if (tailBytes >= maxTailBytes) break;
      tailBytes = Math.min(size, tailBytes * 2);
    }

    return null;
  } catch {
    return null;
  } finally {
    try {
      await file?.close();
    } catch {
      // ignore
    }
  }
}

export async function readCodexTurnTokenUsageFromRollout(rolloutPath: string): Promise<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
} | null> {
  let text: string;
  try {
    text = await fs.readFile(rolloutPath, "utf8");
  } catch {
    return null;
  }

  let sawAny = false;

  let inputTokensSum = 0;
  let cachedInputTokensSum = 0;
  let outputTokensSum = 0;
  let reasoningOutputTokensSum = 0;
  let totalTokensSum = 0;

  // Best-effort de-dupe: token_count can appear multiple times with the same totals.
  let lastSeenTotalTokens: number | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.includes("token_count")) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(event)) continue;
    if (event.type !== "event_msg") continue;

    const payload = event.payload;
    if (!isRecord(payload)) continue;
    if (payload.type !== "token_count") continue;

    const info = payload.info;
    if (!isRecord(info)) continue;

    const totalUsage = info.total_token_usage;
    if (isRecord(totalUsage)) {
      const totalTokensRaw = asFiniteNumber(totalUsage.total_tokens);
      if (totalTokensRaw !== null) {
        if (lastSeenTotalTokens !== null && totalTokensRaw === lastSeenTotalTokens) {
          continue;
        }
        lastSeenTotalTokens = totalTokensRaw;
      }
    }

    const lastUsage = info.last_token_usage;
    if (!isRecord(lastUsage)) continue;

    const inputTokens = asFiniteNumber(lastUsage.input_tokens);
    const cachedInputTokens = asFiniteNumber(lastUsage.cached_input_tokens);
    const outputTokens = asFiniteNumber(lastUsage.output_tokens);
    const reasoningOutputTokens = asFiniteNumber(lastUsage.reasoning_output_tokens);
    const totalTokens = asFiniteNumber(lastUsage.total_tokens);

    if (
      inputTokens === null ||
      cachedInputTokens === null ||
      outputTokens === null ||
      reasoningOutputTokens === null ||
      totalTokens === null
    ) {
      continue;
    }

    sawAny = true;
    inputTokensSum += inputTokens;
    cachedInputTokensSum += cachedInputTokens;
    outputTokensSum += outputTokens;
    reasoningOutputTokensSum += reasoningOutputTokens;
    totalTokensSum += totalTokens;
  }

  if (!sawAny) return null;

  return {
    inputTokens: inputTokensSum,
    cachedInputTokens: cachedInputTokensSum,
    outputTokens: outputTokensSum,
    reasoningOutputTokens: reasoningOutputTokensSum,
    totalTokens: totalTokensSum,
  };
}
