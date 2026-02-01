# Cron Schedules

Hi-Boss supports **cron schedules** as a thin layer on top of envelopes:

- A cron schedule is **persistent** (stored in SQLite).
- Each schedule **materializes** exactly one pending envelope at a time, with `deliver-at` set to the next cron occurrence.
- When that envelope becomes `done`, Hi-Boss materializes the next occurrence.

This keeps the core invariant intact: **envelopes are still the only delivery unit**.

---

## Storage

Table: `cron_schedules` (see `src/daemon/db/schema.ts`)

Important columns:

- `agent_name` — schedule owner (also the sender; `from = agent:<agent_name>`)
- `cron` — cron expression (5-field or 6-field with optional seconds; `@daily` etc are supported)
- `timezone` — optional IANA timezone; `NULL` means “local timezone of the daemon host”
- `enabled` — `1` or `0`
- `pending_envelope_id` — the envelope id for the next scheduled occurrence (nullable)
- `to_address`, `content_text`, `content_attachments`, `metadata` — envelope template fields

---

## Timezone behavior

- If `timezone` is set, it is interpreted as an **IANA timezone** (e.g., `Asia/Tokyo`).
- If `timezone` is `NULL`, the schedule uses the daemon host’s **current local timezone** (as returned by `Intl.DateTimeFormat().resolvedOptions().timeZone`).

The materialized envelope always stores `deliver-at` as a **UTC ISO 8601** timestamp (`...Z`).

---

## Misfire policy (skip)

On daemon start, Hi-Boss applies a **skip misfires** policy:

- If a schedule is enabled and its `pending_envelope_id` points to a **due** envelope (its `deliver-at <= now`), that envelope is **canceled** (marked `done`) and the schedule is advanced to the next occurrence after `now`.

This happens before the envelope scheduler’s startup tick, so missed cron runs are not delivered after downtime.

---

## Delivery + advancement

- Channel envelopes created by cron are marked `done` after a successful adapter send (`src/daemon/router/message-router.ts`), then the schedule is advanced.
- Agent envelopes created by cron are marked `done` after a successful agent run auto-acks envelopes (`src/agent/executor.ts`), then the schedule is advanced.

Cron-created envelopes include `metadata.cronScheduleId` so the daemon can advance the correct schedule.

---

## CLI / RPC

- CLI: `hiboss cron ...` (see `docs/spec/cli/cron.md`)
- RPC: `cron.*` methods (see `docs/spec/ipc.md`)
