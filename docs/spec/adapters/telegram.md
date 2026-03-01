# Telegram Adapter

The Telegram adapter bridges Telegram updates and Hi-Boss envelopes.

Key files:

- `src/adapters/telegram.adapter.ts`
- `src/adapters/telegram/incoming.ts`
- `src/adapters/telegram/outgoing.ts`
- `src/daemon/bridges/channel-bridge.ts`
- `src/daemon/channel-commands.ts`

## Inbound / Outbound

Inbound (Telegram -> agent):

- envelopes are created with `from: channel:telegram:<chat-id>`
- `fromBoss` is set when sender username matches configured `telegram.boss-ids`

Outbound (agent -> Telegram):

- standard channel delivery via router/adapter
- optional reply quoting resolved from `replyToEnvelopeId`

## Command Authorization

By default (no `user-permission-policy` configured), Telegram commands are boss-only (non-boss receives no reply).

When `user-permission-policy` is configured, command/message authorization is role-based:
- command actions: `channel.command.<name>`
- message action: `channel.message.send`
- role lookup prefers adapter `user-id`; `username` is optional fallback

Supported commands:

- `/new` -> switch current chat to a fresh default session
- `/sessions` -> list recent sessions (tabs + pager)
- `/session <id>` -> switch current chat to selected session
- `/trace` -> show current run trace (no run-id required)
- `/provider <claude|codex> [model=<name|default>] [reasoning-effort=<none|low|medium|high|xhigh|default>]` -> switch agent provider and optionally set provider/model/reasoning; requests full session refresh on change
- `/status` -> agent status (includes override and effective provider/model/reasoning fields)
- `/abort` -> cancel current runs and clear due pending non-cron inbox
- `/isolated` -> one-shot fresh run
- `/clone` -> one-shot clone-context run

## Interactive Session Browser

`/sessions` renders inline keyboard:

- tab row: `当前聊天 / 我的聊天 / 该Agent全部` (localized)
- pager row: prev / page / next

Callbacks are handled through Telegram `callback_query`, mapped back to the same command handler and edited in-place when possible (fallback to new message when edit fails).

## Address and Metadata

Address format:

- `channel:telegram:<chat-id>` (`chat-id` is numeric; groups are negative)

Stored envelope metadata includes:

```ts
metadata: {
  platform: "telegram",
  channelMessageId: string,
  channelUser: { id, username?, displayName },
  chat: { id, name? }
}
```

## Limits / Behavior

- text split limit: 4096 chars
- caption limit: 1024 chars
- media-group send prefers `sendMediaGroup`
- uploaded filenames preserve provided filename or basename
- typing status heartbeat runs while related agent run is active

## Configuration

`telegram.boss-ids` (from setup/settings) defines boss identities.

Comparison is case-insensitive and accepts optional `@` prefix.
