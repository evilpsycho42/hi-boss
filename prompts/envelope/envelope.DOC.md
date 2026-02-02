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
| `from-name` | Only for channel messages | Group name or author name (for direct messages) |
| `channel-message-id` | Only for channel messages | Platform message id (Telegram uses compact base36, no prefix; use with `hiboss envelope send --reply-to ...` and `hiboss reaction set --channel-message-id ...`) |
| `created-at` | Only for direct/agent messages | Timestamp (group messages show per-message timestamps) |
| `deliver-at` | Only for scheduled messages | Requested delivery time |

## Message Fields (group messages)

Each message in a group shows:
- Author with `[boss]` suffix if sender is the configured boss
- Timestamp
- Text content
- Attachments (only if present)

Attachment format: `- [type] filename (source)` where type is `image`, `audio`, `video`, or `file`.

## Full Example (group, single message)

```
from: channel:telegram:6447779930
from-name: group "hiboss-test"

Kevin (@kky1024) [boss] at 2026-01-28T20:08:45+08:00:
Here's the weekly report and the updated diagram.
attachments:
- [file] report.pdf (/tmp/downloads/report.pdf)
- [image] diagram.png (/tmp/downloads/diagram.png)
```

## Multiple Envelopes (list output)

`hiboss envelope list` prints one envelope instruction per envelope, separated by a blank line. In group chats, multiple messages appear as multiple envelopes, each repeating the same `from:` / `from-name:` header.

## Full Example (direct message)

```
from: channel:telegram:6447779930
from-name: Kevin (@kky1024) [boss]
created-at: 2026-01-28T20:08:45+08:00
text:
Here's the weekly report.
attachments:
- [file] report.pdf (/tmp/downloads/report.pdf)
```

Note: Direct messages use the original format since there's no group and only one author.

## Full Example (agent-to-agent)

```
from: agent:scheduler
created-at: 2026-01-28T20:08:45+08:00
text:
Time to run the daily backup.
```

Note: `from-name` is omitted since the address is already readable. `attachments:` is omitted when there are none.
