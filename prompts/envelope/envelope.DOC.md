# Envelope Format (Documentation)

The envelope is rendered by the prompt template entrypoint:

- `prompts/envelope/instruction.md`

Hi-Boss supplies fields as template variables (see `prompts/VARIABLES.md`).

## Sections

1. **Header** - routing and metadata
2. **Messages** - author, timestamp, text, attachments

## Header Fields

| Field | Shown | Description |
|-------|-------|-------------|
| `from` | Always | Raw address for routing (use with `--to` when replying) |
| `sender` | Only for channel messages | Sender and chat context (e.g. `Alice (@alice) in group "hiboss-test"` or `Alice (@alice) in private chat`) |
| `channel-message-id` | Only for channel messages | Platform message id (Telegram uses compact base36, no prefix; use with `hiboss envelope send --reply-to ...` and `hiboss reaction set --channel-message-id ...`) |
| `created-at` | Always | Timestamp (boss timezone offset) |
| `deliver-at` | Only for scheduled messages | Requested delivery time |
| `cron-id` | Only for cron messages | Cron schedule id (short id) |

## Message Body

The body is printed as plain text (or `(none)`), followed by an `attachments:` block only when present.

Attachment format: `- [type] filename (source)` where type is `image`, `audio`, `video`, or `file`.

## Full Example (group, single message)

```
from: channel:telegram:6447779930
sender: Kevin (@kky1024) [boss] in group "hiboss-test"
channel-message-id: zik0zj
created-at: 2026-01-28T20:08:45+08:00

Here's the weekly report and the updated diagram.
attachments:
- [file] report.pdf (/tmp/downloads/report.pdf)
- [image] diagram.png (/tmp/downloads/diagram.png)
```

## Multiple Envelopes (list output)

`hiboss envelope list` prints one envelope instruction per envelope, separated by a blank line. In group chats, multiple messages appear as multiple envelopes, each repeating the same `from:` / `sender:` header.

## Full Example (direct message)

```
from: channel:telegram:6447779930
sender: Kevin (@kky1024) [boss] in private chat
channel-message-id: zik0zi
created-at: 2026-01-28T20:08:45+08:00

Here's the weekly report.
attachments:
- [file] report.pdf (/tmp/downloads/report.pdf)
```

## Full Example (agent-to-agent)

```
from: agent:scheduler
created-at: 2026-01-28T20:08:45+08:00

Time to run the daily backup.
```

Note: `sender` is omitted for agent-origin envelopes since the address is already readable. `attachments:` is omitted when there are none.
