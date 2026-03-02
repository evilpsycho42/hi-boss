# Hi-Boss Definitions

This document defines the field mappings between code (TypeScript), SQLite, and stable CLI output keys for core Hi-Boss entities.

For command flags and examples, see `docs/spec/cli.md` and the topic files under `docs/spec/cli/`.
For generated prompt/envelope instruction examples, run `npm run examples:prompts` (outputs under `examples/prompts/` and `prompts/examples/`).

Cross-cutting naming, boss-marker, and short-id conventions are canonical in `docs/spec/conventions.md`.

Canonical mapping (selected):
- `envelope.deliverAt` → SQLite `deliver_at` → `--deliver-at` → `deliver-at:`
- `envelope.priority` → SQLite `priority` → `--interrupt-now` (when `1`)
- `envelope.createdAt` → SQLite `created_at` → `created-at:`
- `envelope.fromBoss` → SQLite `from_boss` → `[boss]` suffix in rendered sender lines
- `config.bossTimezone` → SQLite `config.boss_timezone` → setup `boss-timezone` → `boss-timezone:`
- `config.uiLocale` → SQLite `config.ui_locale` → env override `HIBOSS_UI_LOCALE` (fixed system-message locale)
- `config.userPermissionPolicy` → SQLite `config.user_permission_policy` → `settings.user-permission-policy`
- `runtime.sessionHandoff.recentDays` → SQLite `config.runtime_session_handoff_recent_days` → `settings.runtime.session-handoff.recent-days`
- `runtime.sessionHandoff.perSessionMaxChars` → SQLite `config.runtime_session_handoff_per_session_max_chars` → `settings.runtime.session-handoff.per-session-max-chars`
- `runtime.sessionHandoff.maxRetries` → SQLite `config.runtime_session_handoff_max_retries` → `settings.runtime.session-handoff.max-retries`

Derived (not stored):
- `daemon-timezone:` is computed from the daemon host (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and printed by setup for operator clarity.

---

## Addresses

| Type | Format | Example |
|------|--------|---------|
| Agent | `agent:<name>` | `agent:nex` |
| Agent send (new chat) | `agent:<name>:new` | `agent:nex:new` |
| Agent send (existing chat) | `agent:<name>:<chat-id>` | `agent:nex:agent-chat-123` |
| Team broadcast | `team:<name>` | `team:research` |
| Team mention | `team:<name>:<agent>` | `team:research:nex` |
| Channel | `channel:<adapter>:<chat-id>` | `channel:telegram:123456` |

Reserved agent addresses:
- `agent:background` — one-shot daemon-executed background job (see `docs/spec/components/agent.md`).

---

## Session Registry

Hi-Boss maintains channel-scoped session state in dedicated SQLite tables.

### `agent_sessions`

| Code (TypeScript) | SQLite column | Notes |
|-------------------|-------------|-------|
| `agentSession.id` | `id` | UUID |
| `agentSession.agentName` | `agent_name` | Owner agent |
| `agentSession.provider` | `provider` | `claude` or `codex` |
| `agentSession.providerSessionId` | `provider_session_id` | Provider thread/session id (nullable) |
| `agentSession.createdAt` | `created_at` | Unix epoch ms |
| `agentSession.lastActiveAt` | `last_active_at` | Unix epoch ms |
| `agentSession.lastAdapterType` | `last_adapter_type` | Last channel adapter (nullable) |
| `agentSession.lastChatId` | `last_chat_id` | Last channel chat id (nullable) |

### `channel_session_bindings`

Default mapping per channel conversation:

| Code (TypeScript) | SQLite column | Notes |
|-------------------|-------------|-------|
| `binding.agentName` | `agent_name` | Owner agent |
| `binding.adapterType` | `adapter_type` | e.g. `telegram` |
| `binding.chatId` | `chat_id` | Channel chat id |
| `binding.defaultSessionId` | `default_session_id` | FK -> `agent_sessions.id` |
| `binding.ownerUserId` | `owner_user_id` | Global user token (nullable) |
| `binding.updatedAt` | `updated_at` | Unix epoch ms |

Unique key: `(agent_name, adapter_type, chat_id)`.

### `channel_session_links`

Visibility/history relation used by `/sessions` tab scopes:

| Code (TypeScript) | SQLite column | Notes |
|-------------------|-------------|-------|
| `link.agentName` | `agent_name` | Owner agent |
| `link.adapterType` | `adapter_type` | Channel adapter |
| `link.chatId` | `chat_id` | Channel chat id |
| `link.sessionId` | `session_id` | FK -> `agent_sessions.id` |
| `link.ownerUserId` | `owner_user_id` | Global user token (nullable) |
| `link.firstSeenAt` | `first_seen_at` | Unix epoch ms |
| `link.lastSeenAt` | `last_seen_at` | Unix epoch ms |

Unique key: `(agent_name, adapter_type, chat_id, session_id)`.

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
| `envelope.priority` | `priority` | Integer priority (`0` normal, `1` interrupt-now) |
| `envelope.deliverAt` | `deliver_at` | Unix epoch ms (UTC) (nullable) |
| `envelope.status` | `status` | `pending` or `done` |
| `envelope.createdAt` | `created_at` | Unix epoch ms (UTC) |
| `envelope.metadata` | `metadata` | JSON (nullable); used for channel semantics and agent chat scope (`chatScope`) |

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
- `envelope-id:` (always; short id derived from the internal envelope UUID)
- `from:` (always; raw address)
- `to:` (always; raw destination address)
- `sender:` (only for channel messages; `Author [boss] in group "<name>"` or `Author [boss] in private chat`)
- `chat:` (optional; `envelope.metadata.chatScope` when present)
- `created-at:` (always; boss timezone offset)
- `deliver-at:` (optional; shown when present, in boss timezone offset)
- `cron-id:` (optional; shown when present; short id derived from the internal cron schedule UUID)

**Reply/quote keys** (only when the incoming channel message is a reply)
- `in-reply-to-from-name:` (optional)
- `in-reply-to-text:` (multiline)
  - Note: adapters may truncate `in-reply-to-text` for safety/size (see adapter specs).

**Delivery error keys** (only when a delivery attempt failed or the daemon terminalized an undeliverable envelope)
- `last-delivery-error-at:` (boss timezone offset)
- `last-delivery-error-kind:`
- `last-delivery-error-message:`

**Body**
- Plain text (or `(none)`)
- `attachments:` followed by a rendered list (only shown if present)

`hiboss envelope send` prints:
- Single send: `id: <envelope-id>` (short id; derived from the internal envelope UUID)
- Team broadcast: one `id:` line per created envelope
- Sender-only team broadcast: `no-recipients: true`
- With `--interrupt-now`, additional parseable keys:
  - `interrupt-now: true`
  - `interrupted-work: true|false`
  - `priority-applied: true`

Notes:
- Channel platform message ids (e.g., Telegram `message_id`) are stored internally in `envelope.metadata.channelMessageId` for adapter delivery, but are intentionally **not rendered** in agent prompts/CLI envelope instructions.
- Agents should use `envelope-id:` + `hiboss envelope send --reply-to <envelope-id>` for quoting (channels) and threading (agent↔agent).
- Chat-scoped routing stores `envelope.metadata.chatScope` (for example `agent-chat-...` or `team:<name>`) and routes agent-origin envelopes via internal channel bindings (`adapter_type="internal"`).
- Envelope creation source is tracked in `envelope.metadata.origin` (`cli | channel | cron | internal`) for history/audit.

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

`hiboss cron explain` prints:
- `cron:`
- `timezone:`
- `count:`
- `evaluated-at:`
- `next-run-1:` ... `next-run-N:`

`hiboss cron enable|disable|delete` print:
- `success: true|false`
- `cron-id: <cron-id>` (short id; derived from the internal cron schedule UUID)

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
| `agent.permissionLevel` | `permission_level` | `restricted`, `standard`, `privileged`, `admin` |
| `agent.sessionPolicy` | `session_policy` | JSON (nullable) |
| `agent.createdAt` | `created_at` | Unix epoch ms (UTC) |
| `agent.lastSeenAt` | `last_seen_at` | Unix epoch ms (UTC) (nullable) |
| `agent.metadata` | `metadata` | JSON (nullable) |

### Agent Metadata (Reserved Keys)

`agent.metadata` is user-extensible, but Hi-Boss reserves some keys for internal state:

- `metadata.sessionHandle`: persisted session resume handle (see `docs/spec/components/session.md`). This key is maintained by the daemon, preserved across `hiboss agent set --metadata-*` and `hiboss agent set --clear-metadata`, and ignored if provided by the user.
- `metadata.providerCli`: optional per-agent provider CLI overrides. Supported shape:
  - `metadata.providerCli.claude.env` (string env map)
  - `metadata.providerCli.codex.env` (string env map)
  - Common examples: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`

### CLI

Command flags:
- `hiboss agent ...`: `docs/spec/cli/agents.md`

Provider homes and provider-home override env handling are canonical in `docs/spec/provider-clis.md`.

Agent defaults:
- `hiboss agent register` requires `--provider` (`claude` or `codex`).
- `agent.model` and `agent.reasoningEffort` are nullable overrides; `NULL` means provider defaults.
- `agent.workspace` is a nullable override; `NULL` means no explicit workspace is stored.
- Effective runtime workspace resolution order:
  - primary active teamspace (`{{HIBOSS_DIR}}/teamspaces/<team-name>/`) when the agent belongs to active teams
  - otherwise `agent.workspace` (if set)
- otherwise user's home directory
- `agent.permissionLevel` defaults to `standard` when not specified.
- On `hiboss agent set`, switching provider without passing `--model` / `--reasoning-effort` clears both overrides to `NULL`.
- On `hiboss agent set`, passing `--bind-adapter-type` + `--bind-adapter-token` for an already-bound adapter type replaces that type’s token for the agent (atomic replace).

Clearing nullable overrides:
- `hiboss agent set --model default` sets `agent.model = NULL` (provider default model)
- `hiboss agent set --reasoning-effort default` sets `agent.reasoningEffort = NULL` (provider default reasoning effort)
- `hiboss agent register --reasoning-effort default` sets `agent.reasoningEffort = NULL` (provider default reasoning effort)
- `hiboss agent register --model default` sets `agent.model = NULL` (provider default model)

### CLI Output Keys

- `hiboss agent register` prints:
  - `name:`
  - `description:` (always; generated default when omitted; may be empty string)
  - `workspace:` (`(none)` when unset)
  - `token:` (printed once; there is no “show token” command)
  - `dry-run: true` (only when `--dry-run` is set)
- In `hiboss agent register` output, `workspace: (none)` means no explicit override is stored; effective runtime workspace falls back to the user's home directory.
- In `hiboss agent register --dry-run`, `token:` is rendered as `(dry-run)` and no agent/token is persisted.
- First-time interactive `hiboss setup` prints setup summary keys including:
  - `daemon-timezone: <iana>`
  - `boss-timezone: <iana>`
  - `primary-agent-token:`
  - `secondary-agent-token:`
  - `admin-token:`
- Setup writes canonical config to `{{HIBOSS_DIR}}/settings.json` (`version: "v0.0.0"`) and mirrors to SQLite runtime cache.
- `hiboss agent delete` prints:
  - `success: true|false`
  - `agent-name:`
- `hiboss agent list` prints fields like `created-at:` (timestamps are shown in boss timezone offset).
- `hiboss agent status` prints:
  - `agent-state:` (`running|idle`)
  - `agent-health:` (`ok|error|unknown`)
  - `pending-count:` (counts due pending envelopes)
  - `current-run-id:` / `current-run-started-at:` (optional)
  - `last-run-status:` (`completed|failed|cancelled|none`)
  - `last-run-*:` fields (optional; see `docs/spec/cli/agents.md`)
- In `hiboss agent status`, session policy is printed as:
  - `session-daily-reset-at:`
  - `session-idle-timeout:`
  - `session-max-context-length:`
- `hiboss agent abort` prints:
  - `success: true|false`
  - `agent-name:`
  - `cancelled-run: true|false`
  - `cleared-pending-count: <n>`

---

## Team

A team groups agents and provides a shared teamspace directory for collaboration context.

### Storage (Code ↔ SQLite)

Tables: `teams`, `team_members` (see `src/daemon/db/schema.ts`)

`teams`:

| Code (TypeScript) | SQLite column | Notes |
|-------------------|-------------|-------|
| `team.name` | `name` | Primary key |
| `team.description` | `description` | Nullable |
| `team.status` | `status` | `active` or `archived` |
| `team.kind` | `kind` | `manual` |
| `team.createdAt` | `created_at` | Unix epoch ms (UTC) |
| `team.metadata` | `metadata` | JSON (nullable) |

`team_members`:

| Code (TypeScript) | SQLite column | Notes |
|-------------------|-------------|-------|
| `teamMember.teamName` | `team_name` | FK -> `teams.name` |
| `teamMember.agentName` | `agent_name` | FK -> `agents.name` |
| `teamMember.source` | `source` | `manual` |
| `teamMember.createdAt` | `created_at` | Unix epoch ms (UTC) |

### Teamspace layout

- Teamspaces are sibling to `agents/`:
  - `{{HIBOSS_DIR}}/teamspaces/<team-name>/`
- Team register initializes teamspace directory.
- Team delete removes teamspace directory.
- Team archive does not remove the directory.

### CLI

Command flags:
- `hiboss team ...`: `docs/spec/cli/teams.md`

### CLI Output Keys

- `hiboss team register|set|status|list` print:
  - `team-name:`
  - `team-status:`
  - `team-kind:`
  - `description:` (`(none)` when unset)
  - `created-at:` (boss timezone offset)
  - `members:` (comma-separated agent names or `(none)`)
- `hiboss team add-member|remove-member` print:
  - `success: true|false`
  - `team-name:`
  - `agent-name:`
- `hiboss team list-members` prints:
  - `team-name:`
  - `member-count:`
  - `no-members: true` (only when empty)
  - repeated records:
    - `agent-name:`
    - `source:`
    - `joined-at:`
- `hiboss team send` prints:
  - `team-name:`
  - `requested-count:`
  - `sent-count:`
  - `failed-count:`
  - `no-recipients: true` (only when recipient set is empty)
  - repeated records:
    - `agent-name:`
    - `status:` (`sent|failed`)
    - `id:` (short envelope id or `none`)
    - `error:` (error message or `none`)
- `hiboss team delete` prints:
  - `success: true|false`
  - `team-name:`

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
- `description:` (`(none)` when unset)
- `workspace:` (`(none)` when unset)
- `provider:` (`(none)` when unset)
- `model:` (`default` when unset)
- `reasoning-effort:` (`default` when unset)
- `permission-level:`
- `bindings:` (`(none)` when no bindings)
- `session-daily-reset-at:` (optional)
- `session-idle-timeout:` (optional)
- `session-max-context-length:` (optional)

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

`hiboss daemon start` (startup failure path) may print:
- `error:` (human-readable startup failure details; can include remediation guidance)
- `log-file:`

---

## TypeScript Interfaces

The current shapes live in:
- `src/envelope/types.ts`
- `src/agent/types.ts`
