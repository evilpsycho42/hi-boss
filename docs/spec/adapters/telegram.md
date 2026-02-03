# Telegram Adapter

The Telegram adapter connects Hi-Boss to Telegram bots, enabling agents to communicate with users via Telegram chats.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────┐     ┌─────────┐
│  Telegram   │────▶│ TelegramAdapter  │────▶│ ChannelBridge │────▶│ Envelope│
│  (user)     │     │ (Telegraf bot)   │     │               │     │ Router  │
└─────────────┘     └──────────────────┘     └───────────────┘     └─────────┘
       ▲                    │
       │                    │
       └────────────────────┘
         (sendMessage)
```

## Message Flow

### Incoming (Telegram → Agent)

1. User sends message in Telegram chat
2. `TelegramAdapter` receives via Telegraf listener (`bot.on("text")`, etc.)
3. Adapter builds `ChannelMessage` from Telegram payload
4. `ChannelBridge.handleChannelMessage()` converts to envelope:
   - `from`: `channel:telegram:<chat-id>`
   - `to`: `agent:<bound-agent-name>`
   - `fromBoss`: `true` if sender matches configured boss username
5. Envelope is stored and agent is triggered

### Outgoing (Agent → Telegram)

1. Agent sends envelope via `hiboss envelope send --to channel:telegram:<chat-id>`
2. `MessageRouter` resolves destination to Telegram adapter
3. `TelegramAdapter.sendMessage()` delivers to Telegram API

## Supported Message Types

| Type | Incoming | Outgoing |
|------|----------|----------|
| Text | ✓ | ✓ |
| Photo | ✓ | ✓ |
| Video | ✓ | ✓ |
| Document | ✓ | ✓ |
| Voice | ✓ | ✓ |
| Audio | ✓ | ✓ |

## Commands

| Command | Description |
|---------|-------------|
| `/new` | Refresh the bound agent session (boss-only) |
| `/status` | Show `hiboss agent status` for the bound agent (boss-only) |

Commands are boss-only: non-boss users get no reply.

## Limitations

- **Incoming media groups (albums)**: When users send multiple images/videos together, Telegram delivers each as a separate message. Only the first message contains the caption. These are currently emitted as independent messages (not grouped).
- **Outgoing media groups (albums)**: When an agent sends 2+ compatible attachments (photos/videos, or same-type documents/audios), Hi-Boss sends them via `sendMediaGroup` so they render as a single album in Telegram.
- **Outgoing captions**: Telegram captions are limited to 1024 characters. If an outgoing envelope includes attachments and text longer than that, Hi-Boss sends the text as a separate message and sends the attachments without a caption.

## Address Format

```
channel:telegram:<chat-id>
```

- `<chat-id>`: Numeric ID assigned by Telegram (can be negative for groups)
- Example: `channel:telegram:6447779930`

## Media Storage

Downloaded attachments are saved to `~/.hiboss/media/` with:
- Original filename when available
- Incremental suffix for duplicates (`file.jpg`, `file_1.jpg`, `file_2.jpg`)
- Original `telegramFileId` preserved for efficient re-sending

---

# Message Schema

## ChannelMessage

Unified message format received from Telegram (and other adapters).

```typescript
interface ChannelMessage {
  id: string;           // Telegram message_id (numeric string)
  platform: string;     // "telegram"
  author: {
    id: string;         // Telegram user ID
    username?: string;  // @username (without @)
    displayName: string;// first_name
  };
  chat: {
    id: string;         // Telegram chat ID
    name?: string;      // Group/supergroup title (undefined for DMs)
  };
  content: {
    text?: string;      // Message text or caption
    attachments?: Attachment[];
  };
  raw: unknown;         // Original Telegram message object
}
```

## Attachment

```typescript
interface Attachment {
  source: string;           // Local file path (e.g., ~/.hiboss/media/photo.jpg)
  filename?: string;        // Original filename for display/type detection
  telegramFileId?: string;  // Telegram file_id for efficient re-sending
}
```

### Attachment Type Detection

Type is inferred from file extension:

| Type | Extensions |
|------|------------|
| image | jpg, jpeg, png, gif, webp, bmp |
| video | mp4, mov, avi, webm, mkv |
| audio | mp3, wav, m4a, ogg, oga, opus, aac, flac |
| file | (everything else) |

## ChannelCommand

```typescript
interface ChannelCommand {
  command: string;         // Command name without slash (e.g., "new")
  args: string;            // Arguments after command
  chatId: string;          // Chat ID where command was issued
  authorUsername?: string; // Username of command issuer
}
```

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
