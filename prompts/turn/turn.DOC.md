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
from: <address>
sender: <sender line>             # only for channel messages
channel-message-id: <id>          # only for channel messages (Telegram: compact base36, no prefix)
created-at: <local ISO-8601>
deliver-at: <local ISO-8601>      # only when present
cron-id: <id>                     # only when present (short id)
```

Then the body is printed as plain text (or `(none)`), followed by an `attachments:` block only when present.

Notes:
- Envelope IDs are intentionally omitted from the rendered turn to keep the input compact; replies should use the `from:` address.
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
from: channel:telegram:6447779930
sender: Kevin (@kky1024) [boss] in group "hiboss-test"
channel-message-id: zik0zj
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
from: channel:telegram:6447779930
sender: Alice (@alice) in private chat
channel-message-id: zik0zi
created-at: 2026-01-28T20:10:12+08:00

Hello!
```

### Example: multiple envelopes (group + agent)

```
## Turn Context

now: 2026-01-28T20:30:00+08:00
pending-envelopes: 3

---
from: channel:telegram:6447779930
sender: Alice (@alice) in group "hiboss-test"
channel-message-id: zik0zj
created-at: 2026-01-28T20:10:12+08:00

Can you take a look at this?

---

from: channel:telegram:6447779930
sender: Kevin (@kky1024) [boss] in group "hiboss-test"
channel-message-id: zik0zk
created-at: 2026-01-28T20:11:30+08:00

Sure — what’s the context?

---

from: agent:scheduler
created-at: 2026-01-28T20:11:30+08:00

Time to run the daily backup.
```
