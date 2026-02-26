# WeChatPadPro Adapter

The WeChatPadPro adapter bridges WeChatPadPro webhook events and Hi-Boss envelopes.

Key files:

- `src/adapters/wechatpadpro.adapter.ts`
- `src/adapters/wechatpadpro/webhook-hub.ts`
- `src/daemon/bridges/channel-bridge.ts`
- `src/daemon/channel-commands.ts`

## Inbound / Outbound

Inbound (WeChatPadPro -> agent):

- ingress mode is webhook-only
- webhook events are normalized into `ChannelMessage`
- envelopes are created with `from: channel:wechatpadpro:<chat-id>`
- `fromBoss` is set when sender id/username matches configured `wechatpadpro.boss-ids`

Outbound (agent -> WeChatPadPro):

- standard channel delivery via router/adapter
- message type mapping:
  - text -> `SendTextMessage`
  - image -> `SendImageMessage`
  - audio -> `SendVoice`
  - video -> `SendVideoMsg`
  - file -> `SendFileMessage`

## Boss-only Commands

WeChatPadPro commands are boss-only (non-boss receives no reply):

- `/new`
- `/sessions`
- `/session <id>`
- `/trace`
- `/provider <claude|codex> [model=<name|default>] [reasoning-effort=<none|low|medium|high|xhigh|default>]`
- `/status`
- `/abort`
- `/isolated`
- `/clone`

`/sessions` is text-only on this adapter (no inline keyboard), with both forms supported:

- `/sessions tab=current-chat page=2`
- `/sessions --tab current-chat --page 2`

## Idempotency

Inbound dedupe is strict:

- primary key: provider message id
- fallback: hash of `chat-id + sender + msg-type + time bucket + normalized text`

## Configuration

Adapter token:

- plain auth key string, or
- JSON containing at least `authKey` (optional `baseUrl`, webhook options)

Boss identities:

- `wechatpadpro.boss-ids` in `settings.json` (comma-list in DB cache under `config.adapter_boss_ids_wechatpadpro`)

Optional environment variables:

- `HIBOSS_WECHATPADPRO_BASE_URL`
- `HIBOSS_WECHATPADPRO_WEBHOOK_LISTEN_HOST`
- `HIBOSS_WECHATPADPRO_WEBHOOK_LISTEN_PORT`
- `HIBOSS_WECHATPADPRO_WEBHOOK_PUBLIC_BASE_URL`
- `HIBOSS_WECHATPADPRO_WEBHOOK_SECRET`
- `HIBOSS_WECHATPADPRO_WEBHOOK_INCLUDE_SELF`
