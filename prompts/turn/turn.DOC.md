# Turn Format (Documentation)

The turn input is rendered by the prompt template entrypoint:

- `prompts/turn/turn.md`

Hi-Boss supplies fields as template variables (see `prompts/VARIABLES.md`).

## Sections

1. **Turn Context** — current time (local timezone)
2. **Envelopes** — one block per envelope (no per-envelope headers)

Separators:
- A `---` line separates major sections and envelopes.

## Turn Context

Always printed:

```
## Turn Context

now: <local ISO-8601>
pending-envelopes: <n>
```

## Envelopes

When there are no pending envelopes:

```
No pending envelopes.
```

When there are pending envelopes, each envelope is printed as:

```
envelope-id: <id>                  # always (short id)
from: <address>
sender: <sender line>             # only for channel messages
created-at: <local ISO-8601>
deliver-at: <local ISO-8601>      # only when present
cron-id: <id>                     # only when present (short id)
```

Then the body is printed as plain text (or `(none)`), followed by an `attachments:` block only when present.

Notes:
- Reply targets: use the incoming `from:` as `--to`. Use `--reply-to <envelope-id>` when you need thread context or Telegram quoting.
- The boss signal is the `[boss]` suffix (not a `from-boss:` output key).
- Each pending envelope is rendered one-by-one (no batching).

## Examples

### Example: no pending envelopes

```
## Turn Context

now: 2026-01-28T20:30:00+08:00
pending-envelopes: 0

---
No pending envelopes.
```

### Example: one group message (with boss + attachments)

```
## Turn Context

now: 2026-01-28T20:30:00+08:00
pending-envelopes: 1

---
envelope-id: 4b7c2d1a
from: channel:telegram:6447779930
sender: Kevin (@kky1024) [boss] in group "hiboss-test"
created-at: 2026-01-28T20:08:45+08:00

Here's the weekly report.
attachments:
- [file] report.pdf (/tmp/downloads/report.pdf)
```

### Example: one direct message (no attachments)

```
## Turn Context

now: 2026-01-28T20:30:00+08:00
pending-envelopes: 1

---
envelope-id: 9d0a61fe
from: channel:telegram:6447779930
sender: Alice (@alice) in private chat
created-at: 2026-01-28T20:10:12+08:00

Hello!
```

### Example: multiple envelopes (group + agent)

```
## Turn Context

now: 2026-01-28T20:30:00+08:00
pending-envelopes: 3

---
envelope-id: 4b7c2d1a
from: channel:telegram:6447779930
sender: Alice (@alice) in group "hiboss-test"
created-at: 2026-01-28T20:10:12+08:00

Can you take a look at this?

---

envelope-id: 7aa9f102
from: channel:telegram:6447779930
sender: Kevin (@kky1024) [boss] in group "hiboss-test"
created-at: 2026-01-28T20:11:30+08:00

Sure — what’s the context?

---

envelope-id: 1f2a3b4c
from: agent:scheduler
created-at: 2026-01-28T20:11:30+08:00

Time to run the daily backup.
```
