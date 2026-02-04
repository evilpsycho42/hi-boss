import { CronExpressionParser } from "cron-parser";

export function normalizeTimeZoneInput(timezone?: string): string | undefined {
  if (!timezone) return undefined;
  const trimmed = timezone.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function computeNextCronUnixMs(params: {
  cron: string;
  timezone?: string; // explicit schedule timezone (IANA); missing means "inherit bossTimezone"
  bossTimezone: string;
  afterDate?: Date;
}): number {
  const after = params.afterDate ?? new Date();
  const afterMs = after.getTime();
  const tz = normalizeTimeZoneInput(params.timezone) ?? params.bossTimezone;

  const interval = CronExpressionParser.parse(params.cron, {
    currentDate: after,
    tz,
  });

  // Ensure strict "next after now" semantics (skip misfires / no immediate delivery).
  let next = interval.next().toDate();
  while (next.getTime() <= afterMs) {
    next = interval.next().toDate();
  }

  return next.getTime();
}
