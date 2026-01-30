import { CronExpressionParser } from "cron-parser";

export function getLocalIanaTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function normalizeTimeZoneInput(timezone?: string): string | undefined {
  if (!timezone) return undefined;
  const trimmed = timezone.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "local") return undefined;
  return trimmed;
}

export function computeNextCronUtcIso(params: {
  cron: string;
  timezone?: string;
  afterDate?: Date;
}): string {
  const after = params.afterDate ?? new Date();
  const afterMs = after.getTime();
  const tz = normalizeTimeZoneInput(params.timezone) ?? getLocalIanaTimeZone();

  const interval = CronExpressionParser.parse(params.cron, {
    currentDate: after,
    tz,
  });

  // Ensure strict "next after now" semantics (skip misfires / no immediate delivery).
  let next = interval.next().toDate();
  while (next.getTime() <= afterMs) {
    next = interval.next().toDate();
  }

  return next.toISOString();
}

