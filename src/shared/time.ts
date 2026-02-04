function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isFiniteUnixMs(ms: number): boolean {
  return typeof ms === "number" && Number.isFinite(ms);
}

type DateTimeParts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
};

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

function parseGmtOffsetToMinutes(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed === "UTC" || trimmed === "GMT") return 0;

  const m = trimmed.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const hh = Number(m[2]);
  const mm = m[3] ? Number(m[3]) : 0;
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh > 23 || mm > 59) return null;
  return sign * (hh * 60 + mm);
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDateTimeDtf(timeZone: string): Intl.DateTimeFormat {
  const key = `dt:${timeZone}`;
  const cached = dtfCache.get(key);
  if (cached) return cached;

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  dtfCache.set(key, dtf);
  return dtf;
}

function getOffsetDtf(timeZone: string): Intl.DateTimeFormat {
  const key = `off:${timeZone}`;
  const cached = dtfCache.get(key);
  if (cached) return cached;

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "shortOffset",
  });
  dtfCache.set(key, dtf);
  return dtf;
}

function getTimeZoneOffsetMinutesAtUtcMs(timeZone: string, utcMs: number): number {
  const dtf = getOffsetDtf(timeZone);
  const parts = dtf.formatToParts(new Date(utcMs));
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const parsed = parseGmtOffsetToMinutes(tz);
  if (typeof parsed === "number") return parsed;
  return 0;
}

function getDateTimePartsAtUtcMs(timeZone: string, utcMs: number): DateTimeParts {
  const dtf = getDateTimeDtf(timeZone);
  const parts = dtf.formatToParts(new Date(utcMs));
  const lookup: Record<string, string> = {};
  for (const p of parts) {
    if (p.type === "year" || p.type === "month" || p.type === "day" || p.type === "hour" || p.type === "minute" || p.type === "second") {
      lookup[p.type] = p.value;
    }
  }
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

function zonedLocalPartsToUnixMs(params: DateTimeParts & { millisecond: number; timeZone: string }): number {
  const baseUtcMs = Date.UTC(
    params.year,
    params.month - 1,
    params.day,
    params.hour,
    params.minute,
    params.second,
    params.millisecond
  );

  // Iteratively refine using the timezone offset at the current guess.
  let guess = baseUtcMs;
  for (let i = 0; i < 4; i++) {
    const offsetMinutes = getTimeZoneOffsetMinutesAtUtcMs(params.timeZone, guess);
    const candidate = baseUtcMs - offsetMinutes * 60_000;
    if (candidate === guess) return candidate;
    guess = candidate;
  }
  return guess;
}

function addMonthsClampedParts(parts: DateTimeParts & { millisecond: number }, deltaMonths: number): DateTimeParts & { millisecond: number } {
  if (!deltaMonths) return { ...parts };

  const monthIndex = parts.month - 1;
  const totalMonths = monthIndex + deltaMonths;
  let { q: yearCarry, r: normalizedMonth } = divMod(totalMonths, 12);
  if (normalizedMonth < 0) {
    normalizedMonth += 12;
    yearCarry -= 1;
  }

  const targetYear = parts.year + yearCarry;
  const lastDay = daysInMonthLocal(targetYear, normalizedMonth);
  const targetDay = Math.min(parts.day, lastDay);

  return {
    ...parts,
    year: targetYear,
    month: normalizedMonth + 1,
    day: targetDay,
  };
}

function addYearsClampedParts(parts: DateTimeParts & { millisecond: number }, deltaYears: number): DateTimeParts & { millisecond: number } {
  if (!deltaYears) return { ...parts };

  const targetYear = parts.year + deltaYears;
  const monthIndex = parts.month - 1;
  const lastDay = daysInMonthLocal(targetYear, monthIndex);
  const targetDay = Math.min(parts.day, lastDay);

  return {
    ...parts,
    year: targetYear,
    day: targetDay,
  };
}

function parseRelativeTimeToUnixMsInTimeZone(input: string, timeZone: string): number | null {
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

  // Interpret relative times in the provided timezone so calendar math (Y/M/D) matches displayed time.
  const nowMs = Date.now();
  const nowParts = getDateTimePartsAtUtcMs(timeZone, nowMs);
  let parts: DateTimeParts & { millisecond: number } = {
    ...nowParts,
    millisecond: new Date(nowMs).getUTCMilliseconds(),
  };

  let addMs = 0;
  for (const seg of segments) {
    const delta = sign * seg.value;
    switch (seg.unit) {
      case "Y":
        parts = addYearsClampedParts(parts, delta);
        break;
      case "M":
        parts = addMonthsClampedParts(parts, delta);
        break;
      case "D": {
        const base = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
        const moved = new Date(base + delta * 86_400_000);
        parts = {
          ...parts,
          year: moved.getUTCFullYear(),
          month: moved.getUTCMonth() + 1,
          day: moved.getUTCDate(),
        };
        break;
      }
      case "h":
        addMs += delta * 3_600_000;
        break;
      case "m":
        addMs += delta * 60_000;
        break;
      case "s":
        addMs += delta * 1_000;
        break;
      default:
        throw new Error(`Invalid deliver-at: ${input} (unknown unit '${seg.unit}')`);
    }
  }

  const baseUtc = zonedLocalPartsToUnixMs({ ...parts, timeZone });
  const finalMs = baseUtc + addMs;
  if (Number.isNaN(finalMs)) {
    throw new Error(`Invalid deliver-at: ${input}`);
  }
  return finalMs;
}

/**
 * Format a unix epoch milliseconds timestamp in the given IANA timezone as ISO 8601 with offset.
 *
 * Example output: 2026-01-27T16:30:00-08:00
 */
export function formatUnixMsAsTimeZoneOffset(ms: number, timeZone: string): string {
  if (!isFiniteUnixMs(ms)) return String(ms);
  if (!timeZone || !timeZone.trim()) return String(ms);

  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(ms);

  const dtParts = getDateTimePartsAtUtcMs(timeZone, ms);
  const offsetMinutes = getTimeZoneOffsetMinutesAtUtcMs(timeZone, ms);

  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offsetHour = pad2(Math.floor(abs / 60));
  const offsetMinute = pad2(abs % 60);

  const year = dtParts.year;
  const month = pad2(dtParts.month);
  const day = pad2(dtParts.day);
  const hour = pad2(dtParts.hour);
  const minute = pad2(dtParts.minute);
  const second = pad2(dtParts.second);

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`;
}

/**
 * Backwards-compatible formatter that renders using the daemon host's local timezone offset.
 * Prefer `formatUnixMsAsTimeZoneOffset(ms, bossTimezone)` for user/agent-visible output.
 */
export function formatUnixMsAsLocalOffset(ms: number): string {
  return formatUnixMsAsTimeZoneOffset(ms, Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/**
 * Format a unix epoch milliseconds timestamp as a UTC ISO 8601 string (with trailing Z).
 */
export function formatUnixMsAsUtcIso(ms: number): string {
  if (!isFiniteUnixMs(ms)) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

/**
 * Parse a user-provided datetime string into a unix epoch milliseconds timestamp (UTC),
 * interpreting timezone-less datetimes in the provided IANA timezone.
 *
 * Accepts:
 * - Relative offsets from now:
 *   - "+2Y3M" (now + 2 years + 3 months)
 *   - "+3h" (now + 3 hours)
 *   - "-15m" (now - 15 minutes)
 * - ISO 8601 with timezone (Z or ±HH:MM / ±HHMM)
 * - ISO-like local datetime without timezone (interpreted in the provided timezone)
 *   - "YYYY-MM-DDTHH:MM[:SS[.mmm]]"
 *   - "YYYY-MM-DD HH:MM[:SS[.mmm]]"
 */
export function parseDateTimeInputToUnixMsInTimeZone(input: string, timeZone: string): number {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Invalid deliver-at: empty value");
  }

  const relative = parseRelativeTimeToUnixMsInTimeZone(trimmed, timeZone);
  if (typeof relative === "number") return relative;

  const hasTimezoneSuffix = /([zZ]|[+-]\d{2}:\d{2}|[+-]\d{4})$/.test(trimmed);
  if (hasTimezoneSuffix) {
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid deliver-at: ${input}`);
    }
    return date.getTime();
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
  const utcMs = zonedLocalPartsToUnixMs({
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: s ? Number(s) : 0,
    millisecond: millis,
    timeZone,
  });

  if (Number.isNaN(utcMs)) {
    throw new Error(`Invalid deliver-at: ${input}`);
  }

  return utcMs;
}

/**
 * Backwards-compatible parser that interprets timezone-less datetimes in the daemon host's local timezone.
 */
export function parseDateTimeInputToUnixMs(input: string): number {
  return parseDateTimeInputToUnixMsInTimeZone(input, Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/**
 * True if deliverAt is missing or due (<= now).
 */
export function isDueUnixMs(deliverAt: number | undefined): boolean {
  if (!deliverAt) return true;
  if (!isFiniteUnixMs(deliverAt)) return true;
  return deliverAt <= Date.now();
}

/**
 * Milliseconds until deliverAt (0 if due/invalid).
 */
export function delayUntilUnixMs(deliverAt: number): number {
  if (!isFiniteUnixMs(deliverAt)) return 0;
  return Math.max(0, deliverAt - Date.now());
}
