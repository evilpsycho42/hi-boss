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

## Boss-only Commands

Telegram commands are boss-only (non-boss receives no reply):

- `/new` -> switch current chat to a fresh active session
- `/sessions` -> list recent sessions (tabs + pager)
- `/session <id>` -> switch current chat to selected session
- `/status` -> agent status
- `/abort` -> cancel current runs and clear due pending non-cron inbox
- `/isolated` -> one-shot fresh run
- `/clone` -> one-shot clone-context run

## Interactive Session Browser

`/sessions` renders inline keyboard:

- tab row: `当前聊天 / 我的聊天 / 该Agent全部` (localized)
- pager row: prev / page / next

Callbacks are handled through Telegram `callback_query`, mapped back to the same command handler and edited in-place when possible (fallback to new message when edit fails).

`/sessions` also accepts text args:

- `tab=current-chat page=2`
- `--tab current-chat --page 2`

## Address and Metadata

Address format:

- `channel:telegram:<chat-id>` (`chat-id` is numeric; groups are negative)

Stored envelope metadata includes:

```ts
metadata: {
  platform: "telegram",
  channelMessageId: string,
  author: { id, username?, displayName },
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
