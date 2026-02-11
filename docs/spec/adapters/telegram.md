# Telegram Adapter

The Telegram adapter connects Hi-Boss to a Telegram bot and turns Telegram updates into envelopes (and vice versa).

Key files:
- `src/adapters/telegram.adapter.ts` (Telegraf bot + adapter implementation)
- `src/adapters/telegram/incoming.ts` (Telegram → `ChannelMessage`)
- `src/adapters/telegram/outgoing.ts` (envelope → Telegram API calls)
- `src/daemon/bridges/channel-bridge.ts` (channel message/command → envelope)

## Flow

Incoming (Telegram → agent):
- Adapter builds a `ChannelMessage` and passes it to `ChannelBridge`.
- The daemon creates an envelope:
  - `from: channel:telegram:<chat-id>`
  - `to: agent:<bound-agent-name>`
  - `fromBoss: true` when sender matches `config.adapter_boss_id_telegram`
- Envelope metadata is populated so prompts can render `sender:` and reply previews (see `docs/spec/definitions.md`).

Outgoing (agent → Telegram):
- Agent sends `hiboss envelope send --to channel:telegram:<chat-id> ...`
- Router resolves the Telegram adapter and calls `sendMessage`.

## Data model (canonical)

Shared types:
- `src/adapters/types.ts` (`ChannelMessage`, `Attachment`, `detectAttachmentType`)

Telegram-specific parsing:
- `src/adapters/telegram/incoming.ts`

## Boss-only commands

Telegram chat commands are boss-only (non-boss users get no reply):
- `/new` — request a session refresh for the bound agent
- `/status` — show `hiboss agent status` for the bound agent
- `/abort` — cancel current run + clear **due** pending inbox for the bound agent

## Limits and behavior (canonical)

Incoming:
- Media groups (albums): Telegram delivers each item as a separate message; only the first has the caption. Hi-Boss emits independent envelopes (no grouping). (`src/adapters/types.ts`)
- Reply previews: `in-reply-to-text` is truncated at 1200 chars and appends `\n\n[...truncated...]\n`. (`src/adapters/telegram/incoming.ts`, `src/adapters/telegram/shared.ts`)

Outgoing:
- Long text: split at 4096 chars; `--reply-to` (if set) applies only to the first chunk. `--reply-to` is provided as an **envelope id** and resolved internally to a Telegram `message_id` for quoting. (`src/adapters/telegram/shared.ts`, `src/daemon/router/message-router.ts`)
- Captions: limited to 1024 chars. If attachments are present and text exceeds the caption limit, Hi-Boss sends the text as a separate message and sends attachments without a caption. (`src/adapters/telegram/shared.ts`, `src/adapters/telegram/outgoing.ts`)
- Albums: when sending 2+ compatible attachments, Hi-Boss prefers `sendMediaGroup` so Telegram renders an album. (`src/adapters/telegram/outgoing.ts`)
- Uploaded filenames: when uploading local files, Hi-Boss sets the Telegram upload filename (prefers `attachment.filename`, else local basename). (`src/adapters/telegram/outgoing.ts`)

## Address format

`channel:telegram:<chat-id>` where `<chat-id>` is the Telegram numeric chat id (negative for groups).

## MessageContent (Outgoing)

```typescript
interface MessageContent {
  text?: string;
  attachments?: Attachment[];
}
```

## Envelope Metadata

When a Telegram message becomes an envelope, additional metadata is stored:

```typescript
metadata: {
  platform: "telegram",
  channelMessageId: string,  // Original Telegram message_id
  author: { id, username?, displayName },
  chat: { id, name? }
}
```

---

# Configuration

## Binding an Agent to Telegram

Use `hiboss agent set` with `--bind-adapter-type telegram` + `--bind-adapter-token ...` (see `docs/spec/cli/agents.md`).

## Boss Identification

The `adapter-boss-id` config (set during `hiboss setup`) identifies the "boss" user. Messages from this username have `fromBoss: true` in envelopes.

See `docs/spec/cli/setup.md` and `docs/spec/configuration.md` for setup config fields and persistence.

Comparison is case-insensitive and handles `@` prefix automatically.
