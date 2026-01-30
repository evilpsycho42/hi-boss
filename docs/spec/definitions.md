# Hi-Boss Definitions

This document defines the field mappings between code (TypeScript), SQLite, CLI flags, and CLI output keys for core Hi-Boss entities.

Naming conventions:
- CLI flags: kebab-case, lowercase
- CLI output keys: kebab-case, lowercase

---

## Addresses

| Type | Format | Example |
|------|--------|---------|
| Agent | `agent:<name>` | `agent:nex` |
| Channel | `channel:<adapter>:<chat-id>` | `channel:telegram:123456` |

---

## Envelope

An envelope is the internal message record stored in SQLite and routed by the daemon.

### Storage (Code ↔ SQLite)

Table: `envelopes` (see `src/daemon/db/schema.ts`)

| Code (TypeScript) | SQLite column | Notes |
|-------------------|-------------|-------|
| `envelope.id` | `id` | UUID |
| `envelope.from` | `from` | Sender address |
| `envelope.to` | `to` | Destination address |
| `envelope.fromBoss` | `from_boss` | `0/1` boolean |
| `envelope.content.text` | `content_text` | Nullable |
| `envelope.content.attachments` | `content_attachments` | JSON (nullable) |
| `envelope.deliverAt` | `deliver_at` | ISO 8601 UTC (nullable) |
| `envelope.status` | `status` | `pending` or `done` |
| `envelope.createdAt` | `created_at` | ISO 8601 UTC |
| `envelope.metadata` | `metadata` | JSON (nullable); used for channel semantics |

### CLI Flags

| Command | Flags |
|--------|-------|
| `hiboss envelope send` | `--to`, `--token`, `--text`, `--text-file`, `--attachment`, `--deliver-at`, `--from` (boss only), `--from-boss` (boss only), `--from-name` (boss only) |
| `hiboss envelope list` | `--token`, `--address` (boss only), `--box`, `--status`, `-n/--limit` (`--n` is deprecated), `--as-turn` |
| `hiboss envelope get` | `--id`, `--token` |

### CLI Output (Envelope Instructions)

`hiboss envelope list` and `hiboss envelope get` render an agent-facing “envelope instruction” (see `src/cli/instructions/format-envelope.ts` and `prompts/envelope/instruction.md`).

`hiboss envelope list --as-turn` renders a turn preview (same shape as agent turn input) using `prompts/turn/turn.md`.

**Header keys**
- `from:` (always; raw address)
- `from-name:` (only for channel messages; group name or author name with `[boss]` suffix for direct)
- `channel-message-id:` (only for channel messages; platform message id, useful for `--reply-to` / reactions)
- `created-at:` (only for direct/agent messages; group messages show per-message timestamps)
- `deliver-at:` (optional; shown when present, in local timezone offset)

**Reply/quote keys** (only when the incoming channel message is a reply)
- `in-reply-to-message-id:`
- `in-reply-to-from-name:` (optional)
- `in-reply-to-text:` (multiline)

**Delivery error keys** (only when a channel delivery attempt failed)
- `last-delivery-error-at:`
- `last-delivery-error-kind:`
- `last-delivery-error-message:`

**Sections (direct/agent messages)**
- `text:` followed by the text (or `(none)`)
- `attachments:` followed by a rendered list (only shown if present)

**Sections (group messages)**
- Message lines: `Author [boss] at timestamp:` followed by text
- `attachments:` only shown if present

`hiboss envelope send` prints:
- `id: <envelope-id>`

### Example: `hiboss envelope get` (group message)

```
from: channel:telegram:6447779930
from-name: group "hiboss-test"

Kevin (@kky1024) [boss] at 2026-01-28T20:08:45+08:00:
Hello!
attachments:
- [image] photo.jpg (/Users/kky/.hiboss/media/photo.jpg)
```

### Example: `hiboss envelope get` (direct message)

```
from: channel:telegram:6447779930
from-name: Kevin (@kky1024) [boss]
created-at: 2026-01-28T20:08:45+08:00
text:
Hello!
attachments:
- [image] photo.jpg (/Users/kky/.hiboss/media/photo.jpg)
```

---

## Agent

An agent is an AI assistant registered with Hi-Boss.

Security note: agent tokens are stored as plaintext in the local SQLite database (not hashed). Protect your `~/.hiboss` directory accordingly.

### Storage (Code ↔ SQLite)

Table: `agents` (see `src/daemon/db/schema.ts`)

| Code (TypeScript) | SQLite column | Notes |
|-------------------|-------------|-------|
| `agent.name` | `name` | Primary key |
| `agent.token` | `token` | Plaintext |
| `agent.description` | `description` | Nullable |
| `agent.workspace` | `workspace` | Nullable |
| `agent.provider` | `provider` | `claude` or `codex` |
| `agent.model` | `model` | Nullable |
| `agent.reasoningEffort` | `reasoning_effort` | See `src/agent/types.ts` for allowed values |
| `agent.autoLevel` | `auto_level` | `low`, `medium`, `high` |
| `agent.permissionLevel` | `permission_level` | `restricted`, `standard`, `privileged` |
| `agent.sessionPolicy` | `session_policy` | JSON (nullable) |
| `agent.createdAt` | `created_at` | ISO 8601 UTC |
| `agent.lastSeenAt` | `last_seen_at` | Nullable |
| `agent.metadata` | `metadata` | JSON (nullable) |

### CLI Flags

| Command | Flags |
|--------|-------|
| `hiboss agent register` | `--token`, `--name`, `--description`, `--workspace`, `--provider`, `--model`, `--reasoning-effort`, `--auto-level`, `--permission-level`, `--metadata-json`, `--metadata-file`, `--bind-adapter-type`, `--bind-adapter-token`, `--session-daily-reset-at`, `--session-idle-timeout`, `--session-max-tokens` |
| `hiboss agent set` | `--token`, `--name`, `--description`, `--workspace`, `--provider`, `--model`, `--reasoning-effort`, `--auto-level`, `--permission-level`, `--session-daily-reset-at`, `--session-idle-timeout`, `--session-max-tokens`, `--clear-session-policy`, `--metadata-json`, `--metadata-file`, `--clear-metadata`, `--bind-adapter-type`, `--bind-adapter-token`, `--unbind-adapter-type` |
| `hiboss agent list` | `--token` |
| `hiboss background` | `--token`, `--task` |

### CLI Output Keys

- `hiboss agent register` prints `token:` once (there is no “show token” command).
- `hiboss setup` / `hiboss setup default` prints `agent-token:` once.
- `hiboss setup` / `hiboss setup default` also prints `boss-token:` once.
- `hiboss agent list` prints fields like `provider:`, `reasoning-effort:`, `auto-level:`, `permission-level:`, `created-at:` (timestamps are shown in local timezone offset).
- `hiboss background` prints no output; it sends an envelope to `agent:<self>` whose text is the background run's final response.
- Session policy is printed as:
  - `session-daily-reset-at:`
  - `session-idle-timeout:`
  - `session-max-tokens:`

---

## Binding

A binding connects an agent to an adapter credential (e.g., a Telegram bot token).

### Storage (Code ↔ SQLite)

Table: `agent_bindings` (see `src/daemon/db/schema.ts`)

| Code (TypeScript) | SQLite column | Notes |
|-------------------|-------------|-------|
| `binding.id` | `id` | UUID |
| `binding.agentName` | `agent_name` | Agent name |
| `binding.adapterType` | `adapter_type` | e.g. `telegram` |
| `binding.adapterToken` | `adapter_token` | Adapter credential |
| `binding.createdAt` | `created_at` | ISO 8601 UTC |

### CLI Flags

| Command | Flags |
|--------|-------|
| `hiboss agent set` | `--name`, `--bind-adapter-type`, `--bind-adapter-token`, `--unbind-adapter-type` |

### CLI Output Keys

`hiboss agent set` prints:
- `success:`
- `agent-name:`
- `bindings:` (optional)

---

## Reaction

Reactions allow agents to add emoji reactions to channel messages.

### CLI Flags

| Command | Flags |
|--------|-------|
| `hiboss reaction set` | `--to`, `--channel-message-id` (`--message-id` is deprecated), `--emoji`, `--token` |

### CLI Output Keys

`hiboss reaction set` prints:
- `success:`

---

## Daemon

The daemon is the background process that manages adapters, routes envelopes, and runs agents.

### CLI Flags

| Command | Flags |
|--------|-------|
| `hiboss daemon start` | `--token`, `--debug` |
| `hiboss daemon stop` | `--token` |
| `hiboss daemon status` | `--token` |

### CLI Output Keys

`hiboss daemon status` prints:
- `running:`
- `start-time:`
- `debug:`
- `adapters:`
- `data-dir:`

---

## Setup

Setup configures Hi-Boss for first use by initializing `~/.hiboss/hiboss.db` (configuration is stored in the SQLite `config` table) and creating the first agent (including provider home directories under `~/.hiboss/agents/<agent-name>/`).

### CLI Commands

```bash
hiboss setup                    # Interactive setup (default)
hiboss setup interactive        # Interactive setup
hiboss setup default --config <path>
```

### Default Setup Options

```bash
hiboss setup default \
  --config <path>
```

---

## Permission

Permissions are enforced by the daemon per operation using a configurable policy stored in `config.permission_policy`.

---

## Config

System configuration is stored in the `config` table as key-value pairs.

Common keys:
- `setup_completed`
- `boss_name`
- `boss_token_hash`
- `default_provider`
- `adapter_boss_id_<adapter-type>`

---

## TypeScript Interfaces (Current)

These are the current shapes in `src/envelope/types.ts` and `src/agent/types.ts`.

### Envelope

```ts
import type { Address } from "../adapters/types.js";

export interface Envelope {
  id: string;
  from: Address;                // "agent:<name>" or "channel:<adapter>:<chat-id>"
  to: Address;
  fromBoss: boolean;
  content: {
    text?: string;
    attachments?: Array<{
      source: string;
      filename?: string;
      telegramFileId?: string;
    }>;
  };
  deliverAt?: string;           // ISO 8601 UTC timestamp (not-before delivery)
  status: "pending" | "done";
  createdAt: string;            // ISO 8601 UTC
  metadata?: Record<string, unknown>;
}
```

### Agent

```ts
export interface Agent {
  name: string;
  token: string;
  description?: string;
  workspace?: string;
  provider?: "claude" | "codex";
  model?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  autoLevel?: "low" | "medium" | "high";
  permissionLevel?: "restricted" | "standard" | "privileged";
  sessionPolicy?: {
    dailyResetAt?: string;    // "HH:MM" local
    idleTimeout?: string;     // e.g. "2h", "30m", "1h30m" (units: d/h/m/s)
    maxTokens?: number;
  };
  createdAt: string;
  lastSeenAt?: string;
  metadata?: Record<string, unknown>;
}
```
