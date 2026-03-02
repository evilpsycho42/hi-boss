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
- `fromBoss` is set when logged-in token belongs to a policy user with `role: admin`
- authorized inbound messages are batched by `ChannelBridge` per chat for `200ms` and then persisted as one envelope (text/attachments merged)

Outbound (agent -> Telegram):

- standard channel delivery via router/adapter
- optional reply quoting resolved from `replyToEnvelopeId`

## Command Authorization

`user-permission-policy` is required; command/message authorization is token-based:
- chat must call `/login <token>` first
- runtime stores per-platform user auth (`channel_user_auth` by `adapter_type + channel_user_id`)
- policy uses `users[]` entries:
  - `role: admin` => access all agents
  - `role: user` + `agents[]` => scoped access
- if target adapter is bound to agent `A`, logged-in token must allow `A`

Supported commands:

- `/login <token>` -> bind chat to token for this bot/adapter context
- `/new` -> switch current chat to a fresh default session
- `/sessions` -> list recent sessions (tabs + pager)
- `/session <id>` -> switch current chat to selected session
- `/trace` -> show current run trace (no run-id required)
- `/provider <claude|codex> [model=<name|default>] [reasoning-effort=<none|low|medium|high|xhigh|default>]` -> switch agent provider and optionally set provider/model/reasoning; requests full session refresh on change
- `/status` -> agent status (includes override and effective provider/model/reasoning fields)
- `/abort` -> cancel current run/queue for this chat only, and clear due pending non-cron inbox from this chat only
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
  channelMessageIds?: string[],
  channelUser: { id, username?, displayName },
  channelUsers?: Array<{ id, username?, displayName }>,
  userTokens?: string[],
  chat: { id, name? }
}
```

## Limits / Behavior

- text split limit: 4096 chars
- caption limit: 1024 chars
- media-group send prefers `sendMediaGroup`
- inbound envelope creation uses a 200ms same-chat debounce window in `ChannelBridge`
- uploaded filenames preserve provided filename or basename
- typing status heartbeat runs while related agent run is active

## Configuration

`telegram.boss-ids` (from setup/settings) is used by setup to generate initial
`user-permission-policy.users` entries (default role: `admin`).
Runtime authorization and boss resolution are token-based via chat login and
`user-permission-policy`, not direct `telegram.boss-ids` checks.
