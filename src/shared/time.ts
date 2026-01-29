function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function daysInMonthLocal(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function divMod(n: number, d: number): { q: number; r: number } {
  const q = Math.trunc(n / d);
  const r = n - q * d;
  return { q, r };
}

function addMonthsClampedLocal(date: Date, deltaMonths: number): Date {
  if (!deltaMonths) return new Date(date.getTime());

  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();

  const totalMonths = month + deltaMonths;
  // Normalize month into [0, 11] with correct year carry for negatives too.
  let { q: yearCarry, r: normalizedMonth } = divMod(totalMonths, 12);
  if (normalizedMonth < 0) {
    normalizedMonth += 12;
    yearCarry -= 1;
  }

  const targetYear = year + yearCarry;
  const lastDay = daysInMonthLocal(targetYear, normalizedMonth);
  const targetDay = Math.min(day, lastDay);

  return new Date(
    targetYear,
    normalizedMonth,
    targetDay,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
}

function addYearsClampedLocal(date: Date, deltaYears: number): Date {
  if (!deltaYears) return new Date(date.getTime());

  const targetYear = date.getFullYear() + deltaYears;
  const month = date.getMonth();
  const day = date.getDate();
  const lastDay = daysInMonthLocal(targetYear, month);
  const targetDay = Math.min(day, lastDay);

  return new Date(
    targetYear,
    month,
    targetDay,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
}

function parseRelativeTimeToUtcIso(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const compact = trimmed.replace(/\s+/g, "");
  const signChar = compact[0];
  if (signChar !== "+" && signChar !== "-") return null;

  const sign = signChar === "+" ? 1 : -1;
  const rest = compact.slice(1);
  if (!rest) {
    throw new Error(
      `Invalid deliver-at: ${input} (expected relative like +2Y3M, +3h, +15m, +30s)`
    );
  }

  const segmentRe = /(\d+)([YMDhms])/g;
  const segments: Array<{ value: number; unit: string }> = [];
  let consumed = "";
  let match: RegExpExecArray | null;

  while ((match = segmentRe.exec(rest))) {
    segments.push({ value: Number(match[1]), unit: match[2] });
    consumed += match[0];
  }

  if (segments.length === 0 || consumed !== rest) {
    throw new Error(
      `Invalid deliver-at: ${input} (expected relative like +2Y3M, +3h, +15m, +30s)`
    );
  }

  let date = new Date();
  for (const seg of segments) {
    const delta = sign * seg.value;
    switch (seg.unit) {
      case "Y":
        date = addYearsClampedLocal(date, delta);
        break;
      case "M":
        date = addMonthsClampedLocal(date, delta);
        break;
      case "D":
        date.setDate(date.getDate() + delta);
        break;
      case "h":
        date.setHours(date.getHours() + delta);
        break;
      case "m":
        date.setMinutes(date.getMinutes() + delta);
        break;
      case "s":
        date.setSeconds(date.getSeconds() + delta);
        break;
      default:
        throw new Error(
          `Invalid deliver-at: ${input} (unknown unit '${seg.unit}')`
        );
    }
  }

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid deliver-at: ${input}`);
  }

  return date.toISOString();
}

/**
 * Format a UTC ISO 8601 timestamp (with Z) as local time with offset.
 *
 * Example output: 2026-01-27T16:30:00+08:00
 */
export function formatUtcIsoAsLocalOffset(utcIso: string): string {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) {
    return utcIso;
  }

  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offsetHour = pad2(Math.floor(abs / 60));
  const offsetMinute = pad2(abs % 60);

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`;
}

/**
 * Get current local time formatted as ISO 8601 with offset.
 *
 * Example output: 2026-01-27T16:30:00+08:00
 */
export function nowLocalIso(): string {
  return formatUtcIsoAsLocalOffset(new Date().toISOString());
}

/**
 * Parse a user-provided datetime string into a UTC ISO 8601 string (with Z).
 *
 * Accepts:
 * - Relative offsets from now:
 *   - "+2Y3M" (now + 2 years + 3 months)
 *   - "+3h" (now + 3 hours)
 *   - "-15m" (now - 15 minutes)
 * - ISO 8601 with timezone (Z or ±HH:MM / ±HHMM)
 * - ISO-like local datetime without timezone (interpreted in local timezone)
 *   - "YYYY-MM-DDTHH:MM[:SS[.mmm]]"
 *   - "YYYY-MM-DD HH:MM[:SS[.mmm]]"
 */
export function parseDateTimeInputToUtcIso(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Invalid deliver-at: empty value");
  }

  const relative = parseRelativeTimeToUtcIso(trimmed);
  if (relative) return relative;

  const hasTimezoneSuffix = /([zZ]|[+-]\d{2}:\d{2}|[+-]\d{4})$/.test(trimmed);
  if (hasTimezoneSuffix) {
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid deliver-at: ${input}`);
    }
    return date.toISOString();
  }

  const normalized = trimmed.replace(" ", "T");
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
  );
  if (!match) {
    throw new Error(
      `Invalid deliver-at: ${input} (expected ISO 8601 like 2026-01-27T16:30:00+08:00, or relative like +2h)`
    );
  }

  const [, y, mo, d, h, mi, s, ms] = match;
  const millis = ms ? Number(ms.padEnd(3, "0")) : 0;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
    millis
  );

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid deliver-at: ${input}`);
  }

  return date.toISOString();
}

/**
 * True if deliverAt is missing or due (<= now).
 */
export function isDueUtcIso(deliverAt: string | undefined): boolean {
  if (!deliverAt) return true;
  const timestamp = Date.parse(deliverAt);
  if (Number.isNaN(timestamp)) return true;
  return timestamp <= Date.now();
}

/**
 * Milliseconds until deliverAt (0 if due/invalid).
 */
export function delayUntilUtcIso(deliverAt: string): number {
  const timestamp = Date.parse(deliverAt);
  if (Number.isNaN(timestamp)) return 0;
  return Math.max(0, timestamp - Date.now());
}
