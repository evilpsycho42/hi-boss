import { nowLocalIso } from "./time.js";

export type DaemonLogLevel = "info" | "warn" | "error";

const SAFE_VALUE = /^[A-Za-z0-9._:@/+-]+$/;

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

export function logEvent(level: DaemonLogLevel, event: string, fields?: Record<string, unknown>): void {
  const parts: string[] = [`ts=${nowLocalIso()}`, `level=${level}`, `event=${event}`];

  for (const [key, value] of Object.entries(fields ?? {})) {
    const formatted = formatValue(value);
    if (formatted === null) continue;
    parts.push(`${key}=${formatted}`);
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

