# Turn Format (Documentation)

The turn input is rendered by the prompt template entrypoint:

- `prompts/turn/turn.md`

Hi-Boss supplies fields as template variables (see `prompts/VARIABLES.md`).

## Sections

1. **Turn Context** — current time (local timezone)
2. **Pending Envelopes** — one section per envelope, with batching for group chats

Separators:
- A `---` line separates major sections and envelopes.

## Turn Context

Always printed:

```
## Turn Context

now: <local ISO-8601>
```

## Pending Envelopes

Header:

```
---
## Pending Envelopes (<n>)
```

When there are no pending envelopes:

```
No pending envelopes.
```

When there are pending envelopes, each envelope is printed as:

```
### Envelope <index>

from: <address>
from-name: <semantic name>        # only when present
channel-message-id: <id>          # only for channel messages (Telegram: compact base36, no prefix)
created-at: <local ISO-8601>      # only for direct/agent messages
```

Then the envelope body depends on whether the message is from a group chat:

- **Group message** (`from-name: group "<name>"`):
  - Message line: `<author> [boss] at <local ISO-8601>:`
  - Followed by the message text
  - `attachments:` block is only shown when present
- **Direct / agent message**:
  - `text:` block is always shown (value may be `(none)`)
  - `attachments:` block is only shown when present

Notes:
- Envelope IDs are intentionally omitted from the rendered turn to keep the input compact; replies should use the `from:` address.
- The boss signal is the `[boss]` suffix (not a `from-boss:` output key).
- **Batching:** consecutive group-chat envelopes with the same `from:` are grouped under a single `### Envelope <index>` header (the header is printed once, followed by multiple message lines).
- The `## Pending Envelopes (<n>)` count is the number of underlying envelopes (messages). With batching, the number of `### Envelope <index>` sections may be smaller than `<n>`.

## Examples

### Example: no pending envelopes

```
## Turn Context

now: 2026-01-28T20:30:00+08:00

---
## Pending Envelopes (0)

No pending envelopes.
```

### Example: one group message (with boss + attachments)

```
## Turn Context

now: 2026-01-28T20:30:00+08:00

---
## Pending Envelopes (1)

### Envelope 1

from: channel:telegram:6447779930
from-name: group "hiboss-test"

Kevin (@kky1024) [boss] at 2026-01-28T20:08:45+08:00:
Here's the weekly report.
attachments:
- [file] report.pdf (/tmp/downloads/report.pdf)
```

### Example: one direct message (no attachments)

```
## Turn Context

now: 2026-01-28T20:30:00+08:00

---
## Pending Envelopes (1)

### Envelope 1

from: channel:telegram:6447779930
from-name: Alice (@alice)
created-at: 2026-01-28T20:10:12+08:00

text:
Hello!
```

### Example: multiple envelopes (batched group + agent)

```
## Turn Context

now: 2026-01-28T20:30:00+08:00

---
## Pending Envelopes (3)

### Envelope 1

from: channel:telegram:6447779930
from-name: group "hiboss-test"

Alice (@alice) at 2026-01-28T20:10:12+08:00:
Can you take a look at this?

Kevin (@kky1024) [boss] at 2026-01-28T20:11:30+08:00:
Sure — what’s the context?

---

### Envelope 2

from: agent:scheduler
created-at: 2026-01-28T20:11:30+08:00

text:
Time to run the daily backup.
```
