# Hi-Boss Definitions

This document defines the field mappings between code (TypeScript), SQLite, and stable CLI output keys for core Hi-Boss entities.

For command flags and examples, see `docs/spec/cli.md` and the topic files under `docs/spec/cli/`.
For generated prompt/envelope instruction examples, run `npm run examples:prompts` (outputs under `examples/prompts/` and `prompts/examples/`).

Cross-cutting naming, boss-marker, and short-id conventions are canonical in `docs/spec/conventions.md`.

Canonical mapping (selected):
- `envelope.deliverAt` → SQLite `deliver_at` → `--deliver-at` → `deliver-at:`
- `envelope.createdAt` → SQLite `created_at` → `created-at:`
- `envelope.fromBoss` → SQLite `from_boss` → `[boss]` suffix in rendered sender lines
- `envelope.metadata.workItemId` → `--work-item-id` → `work-item-id:`
- `workItem.state` → SQLite `work_items.state` → `--state` (work-item commands) → `work-item-state:`
- `workItem.title` → SQLite `work_items.title` → `--title` (work-item update) → `work-item-title:`
- `workItem.projectId` → SQLite `work_items.project_id` → daemon-derived project context key
- `workItem.projectRoot` → SQLite `work_items.project_root` → inferred `project-root:` routing hint when available
- `workItem.orchestratorAgent` → SQLite `work_items.orchestrator_agent` → orchestrator authority binding
- `workItem.channelAllowlist[]` → SQLite `work_item_channel_allowlist.channel_address` → `--add-channel/--remove-channel` → `work-item-channel-allowlist:`
- `workItem.channelAllowlistStrict` → SQLite `work_item_channel_policies.strict_allowlist` → inferred policy behavior for `envelope.send`
- `workItem.specialists[]` → SQLite `work_item_specialists.agent_name` → delegated specialist membership
- `project.id` → SQLite `projects.id` → `--id` / `--project-id` (project commands) → `project-id:`
- `project.root` → SQLite `projects.root` → project workspace boundary for leader selection
- `project.speakerAgent` → SQLite `projects.speaker_agent` → `project-speaker-agent:`
- `project.leaders[]` → SQLite `project_leaders.agent_name` (+ `capabilities_json`, `active`) → `project-leaders:`
- `setupConfig.projects[]` → `setup --config-file` declarative input → SQLite `projects`
- `setupConfig.projects[].leaders[]` → `setup --config-file` declarative input → SQLite `project_leaders`
- `config.bossTimezone` → SQLite `config.boss_timezone` → setup `boss-timezone` → `boss-timezone:`
- `config.setupConfigFile` → SQLite `config.setup_config_file` → daemon-start startup config auto-load source
- `config.setupConfigFingerprint` → SQLite `config.setup_config_fingerprint` → daemon-start auto-load skip check

Derived (not stored):
- `daemon-timezone:` is computed from the daemon host (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and printed by setup for operator clarity.

---

## Addresses

| Type | Format | Example |
|------|--------|---------|
| Agent | `agent:<name>` | `agent:nex` |
| Channel | `channel:<adapter>:<chat-id>` | `channel:telegram:123456` |

Reserved agent addresses:
- `agent:background` — one-shot daemon-executed background job (see `docs/spec/components/agent.md`).

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
- `envelope-id:` (always; short id derived from the internal envelope UUID)
- `from:` (always; raw address)
- `to:` (always; raw destination address)
- `sender:` (only for channel messages; `Author [boss] in group "<name>"` or `Author [boss] in private chat`)
- `created-at:` (always; boss timezone offset)
- `deliver-at:` (optional; shown when present, in boss timezone offset)
- `cron-id:` (optional; shown when present; short id derived from the internal cron schedule UUID)
- `work-item-id:` (optional)
- `work-item-state:` (optional)
- `work-item-title:` (optional)

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
- `id: <envelope-id>` (short id; derived from the internal envelope UUID)

Notes:
- Channel platform message ids (e.g., Telegram `message_id`) are stored internally in `envelope.metadata.channelMessageId` for adapter delivery, but are intentionally **not rendered** in agent prompts/CLI envelope instructions.
- Agents should use `envelope-id:` + `hiboss envelope send --reply-to <envelope-id>` for quoting (channels) and threading (agent↔agent).

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

### CLI Output (Work Items)

`hiboss work-item list|get|update` print parseable key-value output:

- `work-item-id:`
- `work-item-state:`
- `work-item-title:` (`(none)` when empty)
- `work-item-channel-allowlist:` (comma-separated channel addresses or `(none)`)
- `created-at:` (boss timezone offset)
- `updated-at:` (boss timezone offset or `(none)`)

`hiboss work-item list` prints:
- `no-work-items: true` when empty

### CLI Output (Projects)

`hiboss project list|get` print parseable key-value output:

- `project-id:`
- `project-name:`
- `project-root:`
- `project-speaker-agent:`
- `project-main-group-channel:` (`(none)` when empty)
- `project-leaders:` (comma-separated agent names or `(none)`)
- `created-at:` (boss timezone offset)
- `updated-at:` (boss timezone offset or `(none)`)

`hiboss project list` prints:
- `no-projects: true` when empty

`hiboss project select-leader` prints:
- `project-id:`
- `required-capabilities:` (comma-separated or `(none)`)
- `candidate-count:`
- `selected-agent:` (or `(none)`)
- `selected-agent-health:` (`ok|unknown|error` or `(none)`)
- `selected-agent-busy:` (`true|false` or `(none)`)
- `selected-capabilities:` (comma-separated or `(none)`)
- `candidate-<n>:` (`agent=<name>; health=<health>; busy=<true|false>; capabilities=<csv-or-(none)>`)

---

## Work Item

A work item is a persistent orchestration record.

### Storage (Code ↔ SQLite)

Table: `work_items` (see `src/daemon/db/schema.ts`)

| Code (TypeScript) | SQLite column | Notes |
|-------------------|---------------|-------|
| `workItem.id` | `id` | Primary key (normalized id) |
| `workItem.state` | `state` | `new\|triaged\|in-progress\|awaiting-user\|blocked\|done\|archived` |
| `workItem.title` | `title` | Nullable |
| `workItem.projectId` | `project_id` | Nullable project context id |
| `workItem.projectRoot` | `project_root` | Nullable absolute project root |
| `workItem.orchestratorAgent` | `orchestrator_agent` | Nullable orchestrator agent name |
| `workItem.mainGroupChannel` | `main_group_channel` | Nullable main intake/report channel address |
| `workItem.requirementGroupChannel` | `requirement_group_channel` | Nullable requirement discussion channel address |
| `workItem.createdAt` | `created_at` | Unix epoch ms (UTC) |
| `workItem.updatedAt` | `updated_at` | Unix epoch ms (UTC) (nullable) |

Table: `work_item_channel_allowlist` (see `src/daemon/db/schema.ts`)

| Code (TypeScript) | SQLite column | Notes |
|-------------------|---------------|-------|
| `workItem.id` | `work_item_id` | FK to `work_items.id` |
| `workItem.channelAllowlist[]` | `channel_address` | `channel:<adapter>:<chat-id>` |
| n/a | `created_by_agent` | Agent name that added this entry |
| n/a | `created_at` | Unix epoch ms (UTC) |

Table: `work_item_channel_policies` (see `src/daemon/db/schema.ts`)

| Code (TypeScript) | SQLite column | Notes |
|-------------------|---------------|-------|
| `workItem.id` | `work_item_id` | FK to `work_items.id` |
| `workItem.channelAllowlistStrict` | `strict_allowlist` | `0/1`; strict mode for channel boundary checks |
| n/a | `updated_at` | Unix epoch ms (UTC) |

Table: `work_item_specialists` (see `src/daemon/db/schema.ts`)

| Code (TypeScript) | SQLite column | Notes |
|-------------------|---------------|-------|
| `workItem.id` | `work_item_id` | FK to `work_items.id` |
| `workItem.specialists[]` | `agent_name` | Delegated specialist agent name |
| `workItem.specialist.capability` | `capability` | Optional capability tag |
| n/a | `assigned_by` | Delegating agent name |
| n/a | `assigned_at` | Unix epoch ms (UTC) |

Table: `work_item_transitions` (see `src/daemon/db/schema.ts`)

| Code (TypeScript) | SQLite column | Notes |
|-------------------|---------------|-------|
| `workItemTransition.id` | `id` | UUID |
| `workItem.id` | `work_item_id` | FK to `work_items.id` |
| `workItemTransition.fromState` | `from_state` | Nullable (`none -> initial`) |
| `workItemTransition.toState` | `to_state` | Destination lifecycle state |
| `workItemTransition.actor` | `actor` | Optional actor name |
| `workItemTransition.reason` | `reason` | Optional reason tag |
| `workItemTransition.createdAt` | `created_at` | Unix epoch ms (UTC) |

### CLI

Command flags:
- `hiboss work-item ...`: `docs/spec/cli/work-items.md`

---

## Project

A project is a project-scoped orchestration view used to bind workspace, speaker, and candidate leaders.

### Storage (Code ↔ SQLite)

Table: `projects` (see `src/daemon/db/schema.ts`)

| Code (TypeScript) | SQLite column | Notes |
|-------------------|---------------|-------|
| `project.id` | `id` | Primary key (normalized id) |
| `project.name` | `name` | Human-readable project display name |
| `project.root` | `root` | Absolute project root (unique) |
| `project.speakerAgent` | `speaker_agent` | Orchestrator/speaker agent name |
| `project.mainGroupChannel` | `main_group_channel` | Nullable main intake/report channel address |
| `project.createdAt` | `created_at` | Unix epoch ms (UTC) |
| `project.updatedAt` | `updated_at` | Unix epoch ms (UTC) (nullable) |

Table: `project_leaders` (see `src/daemon/db/schema.ts`)

| Code (TypeScript) | SQLite column | Notes |
|-------------------|---------------|-------|
| `project.id` | `project_id` | FK to `projects.id` |
| `projectLeader.agentName` | `agent_name` | Leader agent name |
| `projectLeader.capabilities[]` | `capabilities_json` | JSON string array (nullable) |
| `projectLeader.active` | `active` | `0/1`; leader eligibility flag |
| `projectLeader.updatedAt` | `updated_at` | Unix epoch ms (UTC) |

### CLI

Command flags:
- `hiboss project ...`: `docs/spec/cli/projects.md`

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
| `agent.permissionLevel` | `permission_level` | `restricted`, `standard`, `privileged`, `boss` |
| `agent.sessionPolicy` | `session_policy` | JSON (nullable) |
| `agent.role` | `metadata.role` | `speaker` or `leader` (stored in metadata JSON) |
| `agent.createdAt` | `created_at` | Unix epoch ms (UTC) |
| `agent.lastSeenAt` | `last_seen_at` | Unix epoch ms (UTC) (nullable) |
| `agent.metadata` | `metadata` | JSON (nullable) |

### Agent Metadata (Reserved Keys)

`agent.metadata` is user-extensible, but Hi-Boss reserves some keys for internal state:

- `metadata.sessionHandle`: persisted session resume handle (see `docs/spec/components/session.md`). This key is maintained by the daemon, preserved across `hiboss agent set --metadata-*` and `hiboss agent set --clear-metadata`, and ignored if provided by the user.
- `metadata.role`: logical agent role (`speaker` or `leader`).
- On daemon startup, legacy agents with missing/invalid `metadata.role` are backfilled from binding state and persisted (`bound => speaker`, `unbound => leader`).

### CLI

Command flags:
- `hiboss agent ...`: `docs/spec/cli/agents.md`

Provider homes and provider-home override env handling are canonical in `docs/spec/provider-clis.md`.

Agent defaults:
- `hiboss agent register` requires `--provider` (`claude` or `codex`).
- `hiboss agent register --role <speaker|leader>` is required and sets `agent.role` explicitly.
- `hiboss agent register --role speaker` requires adapter binding flags (`--bind-adapter-type` + `--bind-adapter-token`).
- System prompt rendering requires `agent.role`; missing role metadata is a hard error.
- `agent.model` and `agent.reasoningEffort` are nullable overrides; `NULL` means provider defaults.
- `agent.workspace` is a nullable override; `NULL` means no explicit workspace is stored. Runtime fallback resolves to the user's home directory.
- `agent.permissionLevel` defaults to `standard` when not specified.
- On `hiboss agent set`, switching provider without passing `--model` / `--reasoning-effort` clears both overrides to `NULL`.
- `hiboss agent set` rejects role or binding mutations that would violate required role coverage (`>=1 speaker` and `>=1 leader`).
- Speakers must always have at least one binding.
- On `hiboss agent set`, passing `--bind-adapter-type` + `--bind-adapter-token` for an already-bound adapter type replaces that type’s token for the agent (atomic replace).

Clearing nullable overrides:
- `hiboss agent set --model default` sets `agent.model = NULL` (provider default model)
- `hiboss agent set --reasoning-effort default` sets `agent.reasoningEffort = NULL` (provider default reasoning effort)
- `hiboss agent register --reasoning-effort default` sets `agent.reasoningEffort = NULL` (provider default reasoning effort)
- `hiboss agent register --model default` sets `agent.model = NULL` (provider default model)

### CLI Output Keys

- `hiboss agent register` prints:
  - `name:`
  - `role:`
  - `description:` (always; generated default when omitted; may be empty string)
  - `workspace:` (`(none)` when unset)
  - `token:` (printed once; there is no “show token” command)
  - `dry-run: true` (only when `--dry-run` is set)
- In `hiboss agent register` output, `workspace: (none)` means no explicit override is stored; effective runtime workspace falls back to the user's home directory.
- In `hiboss agent register --dry-run`, `token:` is rendered as `(dry-run)` and no agent/token is persisted.
- First-time interactive `hiboss setup` prints setup summary keys including:
  - `daemon-timezone: <iana>`
  - `boss-timezone: <iana>`
  - `speaker-agent-token:`
  - `leader-agent-token:`
  - `boss-token:`
- `hiboss setup --config-file ... --dry-run` prints parseable diff keys including:
  - `dry-run: true`
  - `first-apply:`
  - `current-agent-count:`
  - `desired-agent-count:`
  - `removed-agents:`
  - `recreated-agents:`
  - `new-agents:`
  - `current-binding-count:`
  - `desired-binding-count:`
- `hiboss setup --config-file ...` (apply) prints the same summary keys with `dry-run: false`, plus per-agent token lines:
  - `agent-name:`
  - `agent-role:`
  - `agent-token:` (printed once)
- `hiboss setup export` never writes `boss-token` or `agent-token` into exported files.
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
- `role:`
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
- `src/shared/work-item.ts`
- `src/shared/project.ts`
