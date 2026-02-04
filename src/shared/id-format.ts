export const DEFAULT_ID_PREFIX_LEN = 8;
export const DEFAULT_CANDIDATE_TEXT_MAX_LEN = 120;

export function compactUuid(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "");
}

export function normalizeIdPrefixInput(value: string): string {
  return compactUuid(value);
}

export function isHexLower(value: string): boolean {
  return /^[0-9a-f]+$/.test(value);
}

export function formatShortId(uuid: string): string {
  const compact = compactUuid(uuid);
  return compact.length <= DEFAULT_ID_PREFIX_LEN
    ? compact
    : compact.slice(0, DEFAULT_ID_PREFIX_LEN);
}

export function computeUniqueCompactPrefixLength(
  compactIds: readonly string[],
  minLen = DEFAULT_ID_PREFIX_LEN
): number {
  if (compactIds.length <= 1) return Math.max(0, minLen);
  const ids = Array.from(compactIds, (id) => id.trim());
  const maxLen = Math.max(...ids.map((id) => id.length));
  let len = Math.max(0, minLen);

  for (; len <= maxLen; len++) {
    const seen = new Set<string>();
    let ok = true;
    for (const id of ids) {
      const prefix = id.slice(0, len);
      if (seen.has(prefix)) {
        ok = false;
        break;
      }
      seen.add(prefix);
    }
    if (ok) return len;
  }

  return maxLen;
}

export function toSingleLineForCli(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function truncateForCli(value: string, maxLen = DEFAULT_CANDIDATE_TEXT_MAX_LEN): string {
  const normalized = toSingleLineForCli(value);
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, Math.max(0, maxLen - 1)) + "…";
}

