# CLI: Reactions

This document specifies `hiboss reaction ...`.

## `hiboss reaction set`

Sets a reaction (emoji) on a channel message.

Flags:
- `--to <address>` (required; channel address e.g., `channel:telegram:<chat-id>`)
- `--channel-message-id <id>` (required; platform message id)
- `--message-id <id>` (deprecated alias for `--channel-message-id`)
- `--emoji <emoji>` (required; unicode emoji)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Example:

```bash
hiboss reaction set --to channel:telegram:<chat-id> --channel-message-id <channel-message-id> --emoji "👍"
```

Output (parseable):
- `success: true|false`

Default permission:
- `restricted`
