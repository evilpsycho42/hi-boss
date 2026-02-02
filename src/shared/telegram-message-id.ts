const BASE36_RE = /^[0-9a-z]+$/i;
const DECIMAL_RE = /^\d+$/;

/**
 * Compact Telegram message-id format for prompt/CLI ergonomics.
 *
 * - Display form: base36(message_id) (lowercase)
 *   - Example: message_id "2147483647" -> "zik0zj"
 *
 * - Input form (accepted):
 *   - base36: "zik0zj" (case-insensitive)
 *   - legacy: "tgzik0zj" (case-insensitive; optional ":" or "-" after "tg")
 *   - explicit decimal: "dec:2147483647" (or "d:2147483647")
 */
export function formatTelegramMessageIdCompact(messageId: string): string {
  const trimmed = messageId.trim();
  if (!trimmed || !DECIMAL_RE.test(trimmed)) return trimmed;

  try {
    return BigInt(trimmed).toString(36);
  } catch {
    return trimmed;
  }
}

function base36ToBigInt(value: string): bigint {
  let acc = 0n;
  const lower = value.toLowerCase();
  for (const ch of lower) {
    const digit = Number.parseInt(ch, 36);
    if (!Number.isFinite(digit) || digit < 0 || digit >= 36) {
      throw new Error(`Invalid base36 digit: ${ch}`);
    }
    acc = acc * 36n + BigInt(digit);
  }
  return acc;
}

function decodeTelegramCompactMessageId(raw: string): bigint {
  const lower = raw.toLowerCase();
  let rest = lower;

  if (rest.startsWith("dec:") || rest.startsWith("d:")) {
    rest = rest.replace(/^dec:|^d:/, "");
    if (!rest || !DECIMAL_RE.test(rest)) {
      throw new Error(`Invalid telegram message id: ${raw}`);
    }
    return BigInt(rest);
  }

  if (rest.startsWith("tg")) {
    rest = rest.slice(2);
  }
  if (rest.startsWith(":") || rest.startsWith("-")) {
    rest = rest.slice(1);
  }

  if (!rest || !BASE36_RE.test(rest)) {
    throw new Error(`Invalid telegram message id: ${raw}`);
  }

  return base36ToBigInt(rest);
}

export function parseTelegramMessageId(value: string, fieldName: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }

  let id: bigint;
  try {
    id = decodeTelegramCompactMessageId(trimmed);
  } catch {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }

  if (id < 0n || id > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }

  return Number(id);
}
