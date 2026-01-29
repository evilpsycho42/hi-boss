# Envelope Header Format (Documentation)

The envelope header is rendered by the prompt template entrypoint:

- `prompts/envelope/instruction.md`

Hi-Boss supplies header fields as template variables (see `prompts/VARIABLES.md`).

## Fields (in order)

| Field | Shown | Description |
|-------|-------|-------------|
| `from` | Always | Raw address for routing (use with `--to` when replying) |
| `from-name` | Only for channel messages | Human-readable name (author + chat) |
| `from-boss` | Always | Whether the sender is the configured boss |
| `created-at` | Always | Timestamp when envelope was created |

## Example: Channel message

```
from: channel:telegram:6447779930
from-name: Kevin (@kky1024) in "hiboss-test"
from-boss: false
created-at: 2026-01-28T20:08:45+08:00
```

## Example: Agent-to-agent message

```
from: agent:scheduler
from-boss: true
created-at: 2026-01-28T20:08:45+08:00
```

Note: `from-name` is omitted for agent-to-agent messages since the address is already readable.
