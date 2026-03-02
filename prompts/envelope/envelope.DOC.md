# Envelope Format (Documentation)

The envelope is rendered by the prompt template entrypoint:

- `prompts/envelope/instruction.md`

Hi-Boss supplies fields as template variables (see `prompts/VARIABLES.md`).

## Sections

1. **Header** - routing and metadata
2. **Messages** - sender, timestamp, text, attachments

## Header Fields

| Field | Shown | Description |
|-------|-------|-------------|
| `envelope-id` | Always | Envelope id (short id). Use with `--reply-to <envelope-id>` for threading/quoting and `hiboss reaction set --envelope-id ...` |
| `from` | Always | Raw address for routing (use with `--to` when replying) |
| `sender` | Only for channel messages | Sender and chat context (e.g. `Alice (@alice) in group "hiboss-test"` or `Alice (@alice) in private chat`) |
| `chat` | Optional | Internal chat scope for agent-origin routing (e.g. `agent-chat-...`, `team:research`) |
| `created-at` | Always | Timestamp (boss timezone offset) |
| `deliver-at` | Only for scheduled messages | Requested delivery time |
| `cron-id` | Only for cron messages | Cron schedule id (short id) |

## Message Body

The body is printed as plain text (or `(none)`), followed by an `attachments:` block only when present.

Attachment format: `- [type] filename (source)` where type is `image`, `audio`, `video`, or `file`.

## Full Example (group, single message)

```text
envelope-id: 4b7c2d1a
from: channel:telegram:6447779930
sender: Kevin (@kky1024) [boss] in group "hiboss-test"
created-at: 2026-01-28T20:08:45+08:00

Here's the weekly report and the updated diagram.
attachments:
- [file] report.pdf (/tmp/downloads/report.pdf)
- [image] diagram.png (/tmp/downloads/diagram.png)
```

## Multiple Envelopes (list output)

`hiboss envelope list` prints one envelope instruction per envelope, separated by a blank line. In group chats, multiple messages appear as multiple envelopes, each repeating the same `from:` / `sender:` header.

## Full Example (direct message)

```text
envelope-id: 9d0a61fe
from: channel:telegram:6447779930
sender: Kevin (@kky1024) [boss] in private chat
created-at: 2026-01-28T20:08:45+08:00

Here's the weekly report.
attachments:
- [file] report.pdf (/tmp/downloads/report.pdf)
```

## Full Example (agent-to-agent)

```text
envelope-id: 1f2a3b4c
from: agent:scheduler
chat: agent-chat-44c8c6c9-4f3a-4af6-a4bb-302a0a80d4e2
created-at: 2026-01-28T20:08:45+08:00

Time to run the daily backup.
```

## Full Example (team mention)

```text
envelope-id: 7aa4b93c
from: agent:alice
to: agent:bob
chat: team:research
created-at: 2026-01-28T20:10:45+08:00

Can you take the data cleanup task?
```

Note: `sender` is omitted for agent-origin envelopes since the address is already readable. `chat` is shown when `metadata.chatScope` is present. `attachments:` is omitted when there are none.
