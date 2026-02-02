# CLI: Reactions

This document specifies `hiboss reaction ...`.

## `hiboss reaction set`

Sets a reaction (emoji) on a channel message.

Flags:
- `--to <address>` (required; channel address e.g., `channel:telegram:<chat-id>`)
- `--channel-message-id <id>` (required; channel message id on the platform. For Telegram, use the compact base36 id shown as `channel-message-id:` in prompts; raw decimal can be passed as `dec:<id>`)
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
