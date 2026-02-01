# CLI: Cron

This document specifies `hiboss cron ...`.

Cron schedules are stored per agent and materialize standard envelopes with `deliver-at` set to the next cron occurrence.

See also:
- `docs/spec/components/cron.md` (cron semantics)
- `docs/spec/components/scheduler.md` (deliver-at scheduling)

## `hiboss cron create`

Creates a cron schedule.

Flags:
- `--cron <expr>` (required; 5-field or 6-field with optional seconds; `@daily` etc supported)
- `--to <address>` (required)
- `--timezone <iana>` (optional; defaults to local; accepts `local`)
- `--text <text>` or `--text -` (stdin) or `--text-file <path>`
- `--attachment <path>` (repeatable)
- `--reply-to <message-id>` (optional; channel destinations only)
- `--parse-mode <mode>` (optional; channel destinations only; `plain|markdownv2|html`)

Output (parseable):

```
cron-id: <cron-id>
```

Default permission:
- `restricted`

## `hiboss cron list`

Lists cron schedules for the current agent.

Empty output:

```
no-crons: true
```

Default permission:
- `restricted`

## `hiboss cron get`

Gets a cron schedule by id.

Default permission:
- `restricted`

## `hiboss cron enable` / `hiboss cron disable` / `hiboss cron delete`

Parseable output:
- `success: true|false`
- `cron-id: <cron-id>`

Default permission:
- `restricted`
