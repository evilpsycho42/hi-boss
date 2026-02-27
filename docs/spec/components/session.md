# Session Management

This document describes how Hi-Boss manages agent sessions.

## Overview

Hi-Boss now supports **channel-scoped active sessions**:

- `channel:*` envelopes use a per-chat active mapping (`agent + adapter + chat-id -> active session`)
- multiple chats can intentionally point to the same session
- non-channel sources (for example agent↔agent / cron inline) use a default per-agent session bucket

Session IDs are UUID-backed internally and shown as short IDs in operator-facing surfaces.

## Session Lifecycle

### Creation

Sessions are created on-demand when an agent processes due envelopes:

1. The executor reads due envelopes for an agent.
2. Envelopes are grouped by target session scope.
3. For `channel:*` envelopes, Hi-Boss resolves/creates active session via `channel_session_bindings`.
4. For non-channel envelopes, Hi-Boss uses the default per-agent session bucket.
5. A runtime session object is loaded or created and reused for that scope.
6. Provider session/thread id is updated from CLI output after each successful run.

### Reuse

- Reuse is scope-local: same scope reuses the same runtime session object.
- Different scopes can run concurrently.
- If two chats are mapped to the same session id, they share context and execute serially.

### Refresh

Sessions are refreshed when:

| Trigger | Description |
|---------|-------------|
| `dailyResetAt` | Configured time of day |
| `idleTimeout` | No activity for configured duration |
| `maxContextLength` | Context-length threshold exceeded |
| Manual `/new` | Creates and switches current chat to a fresh active session |
| Manual `/session <id>` | Switches current chat to a selected visible session |
| Manual `/provider <claude|codex> [...]` | Switches agent provider, optionally sets model/reasoning overrides, and requests agent-wide session refresh when values change |
| Daemon restart | Runtime cache is rebuilt from DB state |

### Session Summary Generation

When Hi-Boss closes an active session (manual `/new`, policy refresh, or daemon shutdown), summary generation uses the **current agent provider settings**:

- provider: `claude` or `codex` from the agent record
- model/reasoning-effort: current agent overrides when set (otherwise provider defaults)
- workspace: agent workspace (fallback: default runtime workspace)
- provider env overrides: `metadata.providerCli.<provider>.env` when configured

Summary generation is best-effort and does not block session close.

## Storage

### In-memory (runtime)

`src/agent/executor.ts` keeps:

- default session cache (non-channel)
- channel session cache (session-id keyed)
- per-session serialization locks
- global/per-agent concurrency semaphores

### SQLite (durable)

Core session tables:

- `agent_sessions`
  - session registry (`provider`, `provider_session_id`, `last_active_at`)
- `channel_session_bindings`
  - current active mapping per `(agent_name, adapter_type, chat_id)`
- `channel_session_links`
  - visibility/history links for listing/filtering session scopes

Legacy best-effort default resume handle remains in `agents.metadata.sessionHandle` for default per-agent scope.

Per-agent session history files:

- path: `agents/<agent>/internal_space/history/YYYY-MM-DD/<session-id>.json`
- schema version: `2`
- payload model: `events[]` (envelope lifecycle), not role/text conversations
  - `envelope-created` (full envelope snapshot + origin)
  - `envelope-status-changed` (`fromStatus`, `toStatus`, `reason`, `outcome`, `origin`)

## Session Listing / Switching (Telegram)

Boss-only commands:

- `/sessions`
  - 3 tabs: `current-chat`, `my-chats`, `agent-all`
  - pagination: 10 per page, up to 100 sessions
  - sorted by `last-active-at` desc
  - supports inline keyboard tab + pager callbacks
- `/session <session-id>`
  - accepts short id / prefix / full UUID
  - switches current chat binding to target session if visible
- `/new`
  - switches current chat to a new fresh session and returns old/new ids
- `/trace`
  - shows the current run trace snapshot (current running run if any; otherwise last finished run)
  - no run-id argument
  - when run is still in progress, returns partial live entries when available
  - returns structured trace entries for Claude and Codex runs
- `/provider <claude|codex> [model=<name|default>] [reasoning-effort=<none|low|medium|high|xhigh|default>]`
  - switches the bound agent provider
  - when provided, updates model/reasoning-effort overrides
  - on provider change without explicit overrides, resets model/reasoning-effort to provider defaults
  - requests agent-wide session refresh when provider/model/reasoning changed (all scopes/chats)

## Concurrency

Execution model:

- **Across sessions:** parallel (bounded)
- **Within one session:** strictly serial (ordering preserved)

Default limits (configurable via settings runtime block):

- per-agent: `4`
- global: `16`

Config keys mirrored into SQLite config cache:

- `runtime_session_concurrency_per_agent`
- `runtime_session_concurrency_global`

## Key Files

| File | Purpose |
|------|---------|
| `src/agent/executor.ts` | Session scope resolution, execution scheduling, concurrency limits |
| `src/daemon/db/database.ts` | Session registry/binding/link persistence |
| `src/daemon/channel-commands.ts` | `/new`, `/sessions`, `/session`, `/trace`, `/provider` behavior |
| `src/daemon/channel-provider-command.ts` | `/provider` provider switch + session refresh behavior |
| `src/daemon/channel-trace-command.ts` | `/trace` run-trace read/render behavior |
| `src/adapters/telegram.adapter.ts` | Telegram command + callback wiring |
| `src/shared/settings.ts` | runtime session concurrency parsing/validation |
