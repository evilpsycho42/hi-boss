# Scheduler (deliver-at)

Hi-Boss supports scheduled delivery via `--deliver-at`. Scheduled envelopes are stored in SQLite and delivered when due.

Cron schedules (`hiboss cron ...`) build on the same mechanism by materializing normal envelopes with `deliver-at` set to the next cron occurrence (see `docs/spec/components/cron.md`).

Key files:

- `src/shared/time.ts` — parses `--deliver-at` into a UTC timestamp
- `src/daemon/scheduler/envelope-scheduler.ts` — wake-up/tick logic
- `src/daemon/db/database.ts` — “due” queries and ordering

---

## `deliver-at` parsing

`hiboss envelope send --deliver-at <time>` accepts:

- Relative: `+2h`, `+30m`, `+1Y2M3D`, `-15m` (units are case-sensitive: `Y/M/D/h/m/s`)
- ISO 8601 with timezone: `2026-01-27T16:30:00+08:00` (or UTC `Z`)
- ISO-like local datetime without timezone (interpreted as local time): `YYYY-MM-DDTHH:MM[:SS]` or `YYYY-MM-DD HH:MM[:SS]`

The daemon parses the input and stores `deliver-at` as **UTC** ISO 8601 (`...Z`) in the `envelopes.deliver_at` column.

---

## What counts as “due”?

An envelope is considered due when:

- `deliver_at` is `NULL`, or
- `deliver_at <= now` (string compare in SQLite on ISO timestamps)

This is enforced in queries like:

- `getPendingEnvelopesForAgent(...)`
- `listDueChannelEnvelopes(...)`
- `listAgentNamesWithDueEnvelopes(...)`

---

## Tick behavior

When the daemon starts it calls `EnvelopeScheduler.start()`, which immediately runs a tick (`tick("startup")`).

Each tick does:

1. **Deliver due channel envelopes**
   - `db.listDueChannelEnvelopes(limit)` returns due envelopes where `to LIKE 'channel:%'`
   - The scheduler calls `router.deliverEnvelope(env)` for each
2. **Trigger agents with due envelopes**
   - `db.listAgentNamesWithDueEnvelopes()` returns agent names with due pending envelopes
   - The scheduler calls `executor.checkAndRun(agent, db)` (non-blocking)

The scheduler then computes the next wake time.

---

## Wake-up algorithm

The scheduler chooses the next wake time by querying the earliest pending scheduled envelope:

- `db.getNextScheduledEnvelope()` returns the pending envelope with the smallest `deliver_at` where `deliver_at > now`

Then it schedules one of:

- `setImmediate(tick("due-now"))` if the next envelope is already due (delay <= 0)
- `setTimeout(tick("timer"), clampedDelay)` otherwise

The delay is clamped to Node’s maximum `setTimeout` delay (`2_147_483_647ms`, about 24.8 days).

---

## Ordering

When selecting due envelopes, the DB layer uses:

- `ORDER BY COALESCE(deliver_at, created_at) ASC, created_at ASC`

This means:

- scheduled envelopes are processed in increasing `deliver-at` order
- immediate envelopes (`deliver_at IS NULL`) are interleaved by `created_at`
