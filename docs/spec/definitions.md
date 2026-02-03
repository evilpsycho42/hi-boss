# Hi-Boss Definitions

This document defines the field mappings between code (TypeScript), SQLite, and stable CLI output keys for core Hi-Boss entities.

For command flags and examples, see `docs/spec/cli.md` and the topic files under `docs/spec/cli/`.

Naming conventions:
- CLI flags: kebab-case, lowercase
- CLI output keys: kebab-case, lowercase

Canonical mapping (selected):
- `envelope.deliverAt` → SQLite `deliver_at` → `--deliver-at` → `deliver-at:`
- `envelope.createdAt` → SQLite `created_at` → `created-at:` (direct/agent messages only)
- `envelope.fromBoss` → SQLite `from_boss` → `[boss]` suffix in rendered sender lines

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

### CLI

Command flags:
- `hiboss envelope ...`: `docs/spec/cli/envelopes.md`
- `hiboss cron ...`: `docs/spec/cli/cron.md`

### CLI Output (Envelope Instructions)

`hiboss envelope list` renders an agent-facing “envelope instruction” (see `src/cli/instructions/format-envelope.ts` and `prompts/envelope/instruction.md`).

**Header keys**
- `from:` (always; raw address)
- `status:` (always; `pending|done`)
- `from-name:` (only for channel messages; group name or author name with `[boss]` suffix for direct)
- `channel-message-id:` (only for channel messages; platform message id. For Telegram, rendered in compact base36 (no prefix); accepted by `--reply-to` and `hiboss reaction set --channel-message-id` using the displayed value. Raw decimal can be passed as `dec:<id>`.)
- `created-at:` (only for direct/agent messages; group messages show per-message timestamps)
- `deliver-at:` (optional; shown when present, in local timezone offset)

**Reply/quote keys** (only when the incoming channel message is a reply)
- `in-reply-to-channel-message-id:` (Telegram uses the same compact base36 (no prefix) form)
- `in-reply-to-from-name:` (optional)
- `in-reply-to-text:` (multiline)
  - Note: adapters may truncate `in-reply-to-text` for safety/size. The Telegram adapter truncates at 1200 characters and appends `\n\n[...truncated...]\n`.

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

Envelope instructions printed by `hiboss envelope list` do **not** include the internal envelope id.

### CLI Output (Cron Schedules)

`hiboss cron list` prints parseable key-value output.

**Common keys**
- `cron-id:`
- `cron:`
- `timezone:` (`local` when not set)
- `enabled:` (`true|false`)
- `to:`
- `next-deliver-at:` (local timezone offset or `(none)`)
- `pending-envelope-id:` (or `(none)`)
- `created-at:` (local timezone offset)
- `updated-at:` (optional; local timezone offset)

**Template keys** (only when present)
- `parse-mode:`

**Template sections**
- `text:` followed by the template text (or `(none)`)
- `attachments:` followed by a rendered list (only shown if present)

`hiboss cron list` prints:
- `no-crons: true` when empty

`hiboss cron create` prints:
- `cron-id: <cron-id>`

`hiboss cron enable|disable|delete` print:
- `success: true|false`
- `cron-id: <cron-id>`

### Example: Envelope instruction (group message)

```
from: channel:telegram:6447779930
from-name: group "hiboss-test"
channel-message-id: zik0zj

Kevin (@kky1024) [boss] at 2026-01-28T20:08:45+08:00:
Hello!
attachments:
- [image] photo.jpg (/Users/kky/.hiboss/media/photo.jpg)
```

### Example: Envelope instruction (direct message)

```
from: channel:telegram:6447779930
from-name: Kevin (@kky1024) [boss]
channel-message-id: zik0zi
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
| `agent.model` | `model` | Nullable; `NULL` means “use provider default model” |
| `agent.reasoningEffort` | `reasoning_effort` | See `src/agent/types.ts` for allowed values; `NULL` means “use provider default reasoning effort” |
| `agent.autoLevel` | `auto_level` | `medium`, `high` (unified-agent-sdk supports `low`, but Hi-Boss disallows it; any stored `low` values are migrated to `medium`) |
| `agent.permissionLevel` | `permission_level` | `restricted`, `standard`, `privileged`, `boss` |
| `agent.sessionPolicy` | `session_policy` | JSON (nullable) |
| `agent.createdAt` | `created_at` | ISO 8601 UTC |
| `agent.lastSeenAt` | `last_seen_at` | Nullable |
| `agent.metadata` | `metadata` | JSON (nullable) |

### Agent Metadata (Reserved Keys)

`agent.metadata` is user-extensible, but Hi-Boss reserves some keys for internal state:

- `metadata.sessionHandle`: persisted session resume handle (see `docs/spec/components/session.md`). This key is maintained by the daemon, preserved across `hiboss agent set --metadata-*` and `hiboss agent set --clear-metadata`, and ignored if provided by the user.

### CLI

Command flags:
- `hiboss agent ...`: `docs/spec/cli/agents.md`

Provider config import:
- `--provider-source-home <path>` overrides the source directory used to import provider config files into the agent’s provider home.

Clearing nullable overrides:
- `hiboss agent set --model default` sets `agent.model = NULL` (provider default model)
- `hiboss agent set --reasoning-effort default` sets `agent.reasoningEffort = NULL` (provider default reasoning effort)
- `hiboss agent register --reasoning-effort default` sets `agent.reasoningEffort = NULL` (provider default reasoning effort)

### CLI Output Keys

- `hiboss agent register` prints `token:` once (there is no “show token” command).
- `hiboss setup` (interactive or `--config-file`) prints `agent-token:` once.
- `hiboss setup` (interactive or `--config-file`) also prints `boss-token:` once.
- `hiboss agent delete` prints:
  - `success: true|false`
  - `agent-name:`
- `hiboss agent list` prints fields like `created-at:` (timestamps are shown in local timezone offset).
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
| `binding.createdAt` | `created_at` | ISO 8601 UTC |

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
- `start-time:`
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
  autoLevel?: "medium" | "high";
  permissionLevel?: "restricted" | "standard" | "privileged" | "boss";
  sessionPolicy?: {
    dailyResetAt?: string;    // "HH:MM" local
    idleTimeout?: string;     // e.g. "2h", "30m", "1h30m" (units: d/h/m/s)
    maxContextLength?: number;
  };
  createdAt: string;
  lastSeenAt?: string;
  metadata?: Record<string, unknown>;
}
```
