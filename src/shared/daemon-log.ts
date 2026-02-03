import { nowLocalIso } from "./time.js";

export type DaemonLogLevel = "info" | "warn" | "error";

const SAFE_VALUE = /^[A-Za-z0-9._:@/+-]+$/;

let debugEnabled = false;

const DEBUG_ONLY_KEYS = new Set([
  "agent-run-id",
  "envelope-id",
  "trigger-envelope-id",
  "input-tokens",
  "output-tokens",
  "cache-read-tokens",
  "cache-write-tokens",
  "total-tokens",
]);

export function setDaemonDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

function formatValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return "none";

  if (typeof value === "boolean") return value ? "true" : "false";

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "none";
  }

  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (SAFE_VALUE.test(raw)) return raw;
  return JSON.stringify(raw);
}

function normalizeField(
  key: string,
  value: unknown,
  options: { debug: boolean }
): { key: string; value: unknown } | null {
  if (!options.debug && DEBUG_ONLY_KEYS.has(key)) return null;

  if (key === "agent-name") {
    return { key: "agent", value };
  }

  if (key === "duration-ms") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return { key: "duration", value: `${(value / 1000).toFixed(1)}s` };
    }
    return { key: "duration", value };
  }

  return { key, value };
}

export function logEvent(level: DaemonLogLevel, event: string, fields?: Record<string, unknown>): void {
  const debug = debugEnabled;
  const parts: string[] = [`ts=${nowLocalIso()}`, `level=${level}`, `event=${event}`];
  const seenKeys = new Set(parts.map((p) => p.split("=")[0]));

  for (const [key, value] of Object.entries(fields ?? {})) {
    const normalized = normalizeField(key, value, { debug });
    if (normalized === null) continue;
    if (seenKeys.has(normalized.key)) continue;

    const formatted = formatValue(normalized.value);
    if (formatted === null) continue;
    parts.push(`${normalized.key}=${formatted}`);
    seenKeys.add(normalized.key);
  }

  process.stdout.write(`${parts.join(" ")}\n`);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || "unknown error";
  if (typeof err === "string") return err || "unknown error";
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}
