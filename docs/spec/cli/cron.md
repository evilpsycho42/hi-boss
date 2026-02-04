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
- `--timezone <iana>` (optional; when omitted, the schedule inherits the current boss timezone)
- `--text <text>` or `--text -` (stdin) or `--text-file <path>`
- `--attachment <path>` (repeatable)
- `--parse-mode <mode>` (optional; channel destinations only; `plain|markdownv2|html`)

Output (parseable):

```
cron-id: <cron-id>  # short id
```

Default permission:
- `restricted`

## `hiboss cron list`

Lists cron schedules for the current agent.

Empty output:

```
no-crons: true
```

Output:
- Prints one cron schedule per block, separated by a blank line.
- Each block uses the canonical cron schedule output keys and template sections (see `docs/spec/definitions.md`).
  - Note: `cron-id:` and `pending-envelope-id:` are rendered as short ids.

Default permission:
- `restricted`

## `hiboss cron enable` / `hiboss cron disable` / `hiboss cron delete`

Flags:
- `--id <id>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Parseable output:
- `success: true|false`
- `cron-id: <cron-id>` (short id)

Input:
- `--id <id>` accepts a short id (8 chars), a longer prefix, or a full UUID (hyphens optional).

Errors:
- If `--id` matches multiple cron schedules, the command exits non-zero and prints:
  - `error: ambiguous-id-prefix`
  - `id-prefix: <prefix>`
  - `match-count: <n>`
  - then repeated candidate blocks:
    - `candidate-id: <longer-prefix>`
    - `candidate-kind: cron`
    - `candidate-cron: <expr>`
    - `candidate-to: <address>`
    - `candidate-enabled: true|false`
    - `candidate-next-deliver-at: <boss-iso>|(none)`

Default permission:
- `restricted`
