import { CronExpressionParser } from "cron-parser";

function formatCronParseError(params: {
  cron: string;
  timezone: string;
  error: unknown;
}): string {
  const raw =
    params.error instanceof Error ? params.error.message.trim() : String(params.error).trim();
  const details = raw ? ` (${raw})` : "";
  return (
    `Invalid cron: ${params.cron}${details}. ` +
    `Expected 5-field/6-field cron (optional seconds) or presets like @daily; timezone=${params.timezone}.`
  );
}

function parseCronInterval(params: {
  cron: string;
  afterDate: Date;
  timezone: string;
}): ReturnType<typeof CronExpressionParser.parse> {
  try {
    return CronExpressionParser.parse(params.cron, {
      currentDate: params.afterDate,
      tz: params.timezone,
    });
  } catch (err) {
    throw new Error(
      formatCronParseError({
        cron: params.cron,
        timezone: params.timezone,
        error: err,
      })
    );
  }
}

function normalizeRunCount(count: number | undefined): number {
  if (count === undefined) return 1;
  if (!Number.isFinite(count)) {
    throw new Error("Invalid count (must be a finite number)");
  }
  const n = Math.trunc(count);
  if (n <= 0) {
    throw new Error("Invalid count (must be >= 1)");
  }
  if (n > 50) {
    throw new Error("Invalid count (max 50)");
  }
  return n;
}

export function normalizeTimeZoneInput(timezone?: string): string | undefined {
  if (!timezone) return undefined;
  const trimmed = timezone.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function computeNextCronUnixMsSeries(params: {
  cron: string;
  timezone?: string; // explicit schedule timezone (IANA); missing means "inherit bossTimezone"
  bossTimezone: string;
  afterDate?: Date;
  count?: number;
}): number[] {
  const after = params.afterDate ?? new Date();
  const afterMs = after.getTime();
  const tz = normalizeTimeZoneInput(params.timezone) ?? params.bossTimezone;
  const wanted = normalizeRunCount(params.count);
  const interval = parseCronInterval({
    cron: params.cron,
    afterDate: after,
    timezone: tz,
  });

  const runs: number[] = [];
  try {
    while (runs.length < wanted) {
      const next = interval.next().toDate();
      const nextMs = next.getTime();
      // Ensure strict "next after now" semantics (skip misfires / no immediate delivery).
      if (nextMs <= afterMs) continue;
      runs.push(nextMs);
    }
  } catch (err) {
    const raw =
      err instanceof Error ? err.message.trim() : String(err).trim();
    const details = raw ? ` (${raw})` : "";
    throw new Error(`Failed to compute next run times${details}`);
  }

  return runs;
}

export function computeNextCronUnixMs(params: {
  cron: string;
  timezone?: string; // explicit schedule timezone (IANA); missing means "inherit bossTimezone"
  bossTimezone: string;
  afterDate?: Date;
}): number {
  return computeNextCronUnixMsSeries({
    ...params,
    count: 1,
  })[0];
}
