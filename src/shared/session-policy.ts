export interface SessionPolicyConfig {
  /**
   * Daily reset time in local timezone.
   * Format: "HH:MM" (24h).
   */
  dailyResetAt?: string;
  /**
   * Refresh session if idle (no runs) exceeds this duration.
   * Format: "<n><unit>[<n><unit>]..." where unit is d/h/m/s (e.g., "2h", "30m", "1h30m").
   */
  idleTimeout?: string;
  /**
   * Refresh session if the estimated context length for a turn exceeds this value.
   *
   * Context length is SDK-provided and best-effort (uses `usage.context_length` when available).
   * If `usage.context_length` is missing, the max-context-length policy is skipped for that run.
   */
  maxContextLength?: number;
}

export interface ParsedDailyResetAt {
  hour: number;
  minute: number;
  normalized: string; // "HH:MM"
}

export interface ParsedSessionPolicy {
  dailyResetAt?: ParsedDailyResetAt;
  idleTimeoutMs?: number;
  maxContextLength?: number;
}

export interface UsageLike {
  context_length?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export function computeTokensUsed(usage: UsageLike | undefined): number | null {
  if (!usage) return null;
  if (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)) {
    return usage.total_tokens;
  }
  return null;
}

export function computeContextLength(usage: UsageLike | undefined): number | null {
  if (!usage) return null;
  if (typeof usage.context_length === "number" && Number.isFinite(usage.context_length)) {
    return usage.context_length;
  }
  return null;
}

export function parseDailyResetAt(input: string): ParsedDailyResetAt {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid daily reset time: ${input} (expected HH:MM)`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Invalid daily reset time: ${input} (hour must be 0-23)`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`Invalid daily reset time: ${input} (minute must be 0-59)`);
  }

  const normalized = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { hour, minute, normalized };
}

export function parseDurationToMs(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Invalid duration: empty value");
  }

  const segmentRe = /(\d+)([dhms])/g;
  let totalMs = 0;
  let consumed = "";
  let match: RegExpExecArray | null;

  while ((match = segmentRe.exec(trimmed))) {
    const value = Number(match[1]);
    const unit = match[2];
    consumed += match[0];

    const deltaMs = (() => {
      switch (unit) {
        case "d":
          return value * 24 * 60 * 60 * 1000;
        case "h":
          return value * 60 * 60 * 1000;
        case "m":
          return value * 60 * 1000;
        case "s":
          return value * 1000;
        default:
          return 0;
      }
    })();

    totalMs += deltaMs;
  }

  if (consumed !== trimmed) {
    throw new Error(`Invalid duration: ${input} (expected like 2h, 30m, 1h30m; units: d/h/m/s)`);
  }

  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    throw new Error(`Invalid duration: ${input} (must be > 0)`);
  }

  return totalMs;
}

export function parseSessionPolicyConfig(
  input: unknown,
  opts: { strict: boolean }
): ParsedSessionPolicy {
  const raw = input as Partial<Record<string, unknown>> | null;
  if (!raw || typeof raw !== "object") return {};

  const parsed: ParsedSessionPolicy = {};

  if (typeof raw.dailyResetAt === "string") {
    try {
      parsed.dailyResetAt = parseDailyResetAt(raw.dailyResetAt);
    } catch (err) {
      if (opts.strict) throw err;
    }
  }

  if (typeof raw.idleTimeout === "string") {
    try {
      parsed.idleTimeoutMs = parseDurationToMs(raw.idleTimeout);
    } catch (err) {
      if (opts.strict) throw err;
    }
  }

  if (typeof raw.maxContextLength === "number" && Number.isFinite(raw.maxContextLength)) {
    if (raw.maxContextLength > 0) {
      parsed.maxContextLength = raw.maxContextLength;
    } else if (opts.strict) {
      throw new Error("Invalid max context length: must be > 0");
    }
  }

  return parsed;
}
