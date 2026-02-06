# Hi-Boss Definitions

This document defines the field mappings between code (TypeScript), SQLite, and stable CLI output keys for core Hi-Boss entities.

For command flags and examples, see `docs/spec/cli.md` and the topic files under `docs/spec/cli/`.

Naming conventions:
- CLI flags: kebab-case, lowercase
- CLI output keys: kebab-case, lowercase

Short IDs:
- Many internal IDs are UUIDs.
- The CLI renders UUID-backed ids as **short ids** by default:
  - short id = first 8 lowercase hex characters of the UUID with hyphens removed.
  - full UUIDs are still accepted as input where an `--id` flag exists.

Canonical mapping (selected):
- `envelope.deliverAt` → SQLite `deliver_at` → `--deliver-at` → `deliver-at:`
- `envelope.createdAt` → SQLite `created_at` → `created-at:`
- `envelope.fromBoss` → SQLite `from_boss` → `[boss]` suffix in rendered sender lines
- `config.bossTimezone` → SQLite `config.boss_timezone` → setup `boss-timezone` → `boss-timezone:`

Derived (not stored):
- `daemon-timezone:` is computed from the daemon host (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and printed by setup for operator clarity.

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
| `envelope.deliverAt` | `deliver_at` | Unix epoch ms (UTC) (nullable) |
| `envelope.status` | `status` | `pending` or `done` |
| `envelope.createdAt` | `created_at` | Unix epoch ms (UTC) |
| `envelope.metadata` | `metadata` | JSON (nullable); used for channel semantics |

Status semantics:
- `pending` means “not yet fully processed”: either waiting for `deliver-at`, waiting for agent read, or waiting for channel delivery attempt.
- `done` means “terminal”: the envelope will not be processed again. `done` can represent a successful delivery/read, or a terminal delivery failure (with details recorded via `last-delivery-error-*` when available).

### CLI

Command flags:
- `hiboss envelope ...`: `docs/spec/cli/envelopes.md`
- `hiboss cron ...`: `docs/spec/cli/cron.md`

### CLI Output (Envelope Instructions)

`hiboss envelope list` renders an agent-facing “envelope instruction” (see `src/cli/instructions/format-envelope.ts` and `prompts/envelope/instruction.md`).

**Header keys**
- `from:` (always; raw address)
- `sender:` (only for channel messages; `Author [boss] in group "<name>"` or `Author [boss] in private chat`)
- `channel-message-id:` (only for channel messages; platform message id. For Telegram, rendered in compact base36 (no prefix); accepted by `--reply-to` and `hiboss reaction set --channel-message-id` using the displayed value. Raw decimal can be passed as `dec:<id>`.)
- `created-at:` (always; boss timezone offset)
- `deliver-at:` (optional; shown when present, in boss timezone offset)
- `cron-id:` (optional; shown when present; short id derived from the internal cron schedule UUID)

**Reply/quote keys** (only when the incoming channel message is a reply)
- `in-reply-to-channel-message-id:` (Telegram uses the same compact base36 (no prefix) form)
- `in-reply-to-from-name:` (optional)
- `in-reply-to-text:` (multiline)
  - Note: adapters may truncate `in-reply-to-text` for safety/size. The Telegram adapter truncates at 1200 characters and appends `\n\n[...truncated...]\n`.

**Delivery error keys** (only when a delivery attempt failed or the daemon terminalized an undeliverable envelope)
- `last-delivery-error-at:` (boss timezone offset)
- `last-delivery-error-kind:`
- `last-delivery-error-message:`

**Body**
- Plain text (or `(none)`)
- `attachments:` followed by a rendered list (only shown if present)

`hiboss envelope send` prints:
- `id: <envelope-id>` (short id; derived from the internal envelope UUID)

Envelope instructions printed by `hiboss envelope list` do **not** include the internal envelope id.

### CLI Output (Cron Schedules)

`hiboss cron list` prints parseable key-value output.

**Common keys**
- `cron-id:` (short id; derived from the internal cron schedule UUID)
- `cron:`
- `timezone:` (`boss` when not set; means inherit boss timezone)
- `enabled:` (`true|false`)
- `to:`
- `next-deliver-at:` (boss timezone offset or `(none)`)
- `pending-envelope-id:` (short id; or `(none)`)
- `created-at:` (boss timezone offset)
- `updated-at:` (optional; boss timezone offset)

**Template keys** (only when present)
- `parse-mode:`

**Template sections**
- `text:` followed by the template text (or `(none)`)
- `attachments:` followed by a rendered list (only shown if present)

`hiboss cron list` prints:
- `no-crons: true` when empty

`hiboss cron create` prints:
- `cron-id: <cron-id>` (short id; derived from the internal cron schedule UUID)

`hiboss cron enable|disable|delete` print:
- `success: true|false`
- `cron-id: <cron-id>` (short id; derived from the internal cron schedule UUID)

### Example: Envelope instruction (group message)

```
from: channel:telegram:6447779930
sender: Kevin (@kky1024) [boss] in group "hiboss-test"
channel-message-id: zik0zj
created-at: 2026-01-28T20:08:45+08:00

Hello!
attachments:
- [image] photo.jpg (/Users/kky/hiboss/media/photo.jpg)
```

### Example: Envelope instruction (direct message)

```
from: channel:telegram:6447779930
sender: Kevin (@kky1024) [boss] in private chat
channel-message-id: zik0zi
created-at: 2026-01-28T20:08:45+08:00

Hello!
attachments:
- [image] photo.jpg (/Users/kky/hiboss/media/photo.jpg)
```

---

## Agent

An agent is an AI assistant registered with Hi-Boss.

Security note: agent tokens are stored as plaintext in the local SQLite database (not hashed). Protect your `~/hiboss` directory accordingly.

### Storage (Code ↔ SQLite)

Table: `agents` (see `src/daemon/db/schema.ts`)

| Code (TypeScript) | SQLite column | Notes |
|-------------------|-------------|-------|
| `agent.name` | `name` | Primary key |
| `agent.token` | `token` | Plaintext |
| `agent.description` | `description` | Nullable |
| `agent.workspace` | `workspace` | Nullable |
| `agent.provider` | `provider` | `claude` or `codex` |
| `agent.model` | `model` | Nullable; `NULL` means “use provider default model” |
| `agent.reasoningEffort` | `reasoning_effort` | See `src/agent/types.ts` for allowed values; `NULL` means “use provider default reasoning effort” |
| `agent.autoLevel` | `auto_level` | `medium`, `high` (Hi-Boss disallows `low`) |
| `agent.permissionLevel` | `permission_level` | `restricted`, `standard`, `privileged`, `boss` |
| `agent.sessionPolicy` | `session_policy` | JSON (nullable) |
| `agent.createdAt` | `created_at` | Unix epoch ms (UTC) |
| `agent.lastSeenAt` | `last_seen_at` | Unix epoch ms (UTC) (nullable) |
| `agent.metadata` | `metadata` | JSON (nullable) |

### Agent Metadata (Reserved Keys)

`agent.metadata` is user-extensible, but Hi-Boss reserves some keys for internal state:

- `metadata.sessionHandle`: persisted session resume handle (see `docs/spec/components/session.md`). This key is maintained by the daemon, preserved across `hiboss agent set --metadata-*` and `hiboss agent set --clear-metadata`, and ignored if provided by the user.

### CLI

Command flags:
- `hiboss agent ...`: `docs/spec/cli/agents.md`

Provider config import:
- `--provider-source-home <path>` overrides the source directory used to import provider config files into the agent’s provider home.
- `--provider-source-home` requires an explicit `--provider` on `hiboss agent register` / `hiboss agent set`.

Agent defaults:
- `hiboss agent register` requires `--provider` (`claude` or `codex`).
- `agent.model` and `agent.reasoningEffort` are nullable overrides; `NULL` means provider defaults.
- `agent.autoLevel` defaults to `medium` when not specified.
- `agent.permissionLevel` defaults to `standard` when not specified.
- On `hiboss agent set`, switching provider without passing `--model` / `--reasoning-effort` clears both overrides to `NULL`.

Clearing nullable overrides:
- `hiboss agent set --model default` sets `agent.model = NULL` (provider default model)
- `hiboss agent set --reasoning-effort default` sets `agent.reasoningEffort = NULL` (provider default reasoning effort)
- `hiboss agent register --reasoning-effort default` sets `agent.reasoningEffort = NULL` (provider default reasoning effort)
- `hiboss agent register --model default` sets `agent.model = NULL` (provider default model)

### CLI Output Keys

- `hiboss agent register` prints `token:` once (there is no “show token” command).
- `hiboss setup` prints:
  - `daemon-timezone: <iana>`
  - `boss-timezone: <iana>`
- `hiboss setup` (interactive or `--config-file`) prints `agent-token:` once.
- `hiboss setup` (interactive or `--config-file`) also prints `boss-token:` once.
- `hiboss agent delete` prints:
  - `success: true|false`
  - `agent-name:`
- `hiboss agent list` prints fields like `created-at:` (timestamps are shown in boss timezone offset).
- `hiboss agent status` prints:
  - `agent-state:` (`running|idle`)
  - `agent-health:` (`ok|error|unknown`)
  - `pending-count:` (counts due pending envelopes)
  - `current-run-id:` / `current-run-started-at:` (optional)
  - `last-run-*:` fields (optional; see `docs/spec/cli/agents.md`)
- In `hiboss agent status`, session policy is printed as:
  - `session-daily-reset-at:`
  - `session-idle-timeout:`
  - `session-max-context-length:`

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
| `binding.createdAt` | `created_at` | Unix epoch ms (UTC) |

### CLI

Binding flags are on `hiboss agent set` (see `docs/spec/cli/agents.md`).

### CLI Output Keys

`hiboss agent set` prints:
- `success:`
- `agent-name:`
- `bindings:` (optional)

---

## Reaction

Reactions allow agents to add emoji reactions to channel messages.

### CLI

Command flags:
- `hiboss reaction ...`: `docs/spec/cli/reactions.md`

### CLI Output Keys

`hiboss reaction set` prints:
- `success:`

---

## Daemon

The daemon is the background process that manages adapters, routes envelopes, and runs agents.

### CLI

Command flags:
- `hiboss daemon ...`: `docs/spec/cli/daemon.md`

### CLI Output Keys

`hiboss daemon status` prints:
- `running:`
- `start-time:` (boss timezone offset or `(none)`)
- `adapters:`
- `data-dir:`

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
  deliverAt?: number;           // unix epoch ms (UTC) (not-before delivery)
  status: "pending" | "done";
  createdAt: number;            // unix epoch ms (UTC)
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
  provider: "claude" | "codex";
  model?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  autoLevel?: "medium" | "high";
  permissionLevel?: "restricted" | "standard" | "privileged" | "boss";
  sessionPolicy?: {
    dailyResetAt?: string;    // "HH:MM" local
    idleTimeout?: string;     // e.g. "2h", "30m", "1h30m" (units: d/h/m/s)
    maxContextLength?: number;
  };
  createdAt: number;      // unix epoch ms (UTC)
  lastSeenAt?: number;    // unix epoch ms (UTC)
  metadata?: Record<string, unknown>;
}
```
