# Agent System

This document describes how Hi-Boss manages agents.

## Overview

Agents are autonomous processes that receive and respond to envelopes. Each agent has a unique name, authentication token, and optional bindings to adapters (e.g., Telegram).

## Agent Data Model

Defined in `src/agent/types.ts`:

```typescript
interface Agent {
  name: string;                                      // Unique identifier
  token: string;                                     // Authentication token
  description?: string;                              // Displayed to other agents
  workspace?: string;                                // Working directory for agent SDK
  provider?: 'claude' | 'codex';                     // SDK provider (default: 'claude')
  model?: string;                                    // Model selection
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  autoLevel?: 'low' | 'medium' | 'high';             // Access/automation level
  permissionLevel?: AgentPermissionLevel;            // Authorization level for CLI/RPC ops
  sessionPolicy?: SessionPolicyConfig;               // Session refresh policy
  createdAt: string;                                 // ISO 8601
  lastSeenAt?: string;                               // ISO 8601
  metadata?: Record<string, unknown>;                // Extensible metadata (for future use)
}
```

### Permission Level

Authorization level for CLI/RPC operations. Values: `restricted < standard < privileged < boss`.

Set permission level with:

```bash
hiboss agent set --name <agent-name> --permission-level <restricted|standard|privileged> --token <boss-token>
```

### Session Policy

Session refresh policy configuration:

```typescript
interface SessionPolicyConfig {
  dailyResetAt?: string;   // "HH:MM" format (24h)
  idleTimeout?: string;    // Duration: "2h", "30m", "1h30m"
  maxTokens?: number;      // Token limit per run
}
```

### Database Schema

Table: `agents` (in `src/daemon/db/schema.ts`)

| Column | Type | Notes |
|--------|------|-------|
| name | TEXT | Primary key |
| token | TEXT | Unique, case-sensitive |
| description | TEXT | Optional |
| workspace | TEXT | Optional |
| provider | TEXT | Default: 'claude' |
| model | TEXT | Optional |
| reasoning_effort | TEXT | Default: 'medium' |
| auto_level | TEXT | Default: 'high' |
| permission_level | TEXT | Default: 'standard' |
| session_policy | TEXT | JSON blob for SessionPolicyConfig |
| created_at | TEXT | ISO 8601 |
| last_seen_at | TEXT | ISO 8601, optional |
| metadata | TEXT | JSON blob (for extensibility) |

## Agent Registration

### CLI Command

```bash
hiboss agent register \
  --token <boss-token> \
  --name <name> \
  --description "Agent description" \
  --workspace "$PWD" \
  --provider <claude|codex> \
  --model <model> \
  --reasoning-effort <none|low|medium|high|xhigh> \
  --auto-level <low|medium|high> \
  --permission-level <restricted|standard|privileged>
```

### Validation

Agent names must match: `^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$`
- Alphanumeric characters
- Hyphens allowed (not at start/end, not consecutive)
- Case-insensitive uniqueness check

### Token Generation

Located in `src/agent/auth.ts`:
- Tokens are 6 random hex characters
- Printed once by `hiboss agent register` (and `hiboss setup`)
- Stored as plaintext in `~/.hiboss/hiboss.db` (table: `agents.token`) — there is no CLI “show token” command
- Used for authenticated `hiboss` operations via `--token` (or `HIBOSS_TOKEN`), subject to the permission policy

## Providers

Hi-Boss supports two agent SDK providers:

| Provider | SDK Package | Home Directory |
|----------|-------------|----------------|
| claude | `@anthropic-ai/claude-agent-sdk` | `~/.hiboss/agents/<name>/claude_home/` |
| codex | `@openai/codex-sdk` | `~/.hiboss/agents/<name>/codex_home/` |

### Provider Configuration

Set at registration or via agent settings:

| Setting | Description | Values |
|---------|-------------|--------|
| `provider` | SDK provider | `claude`, `codex` |
| `model` | Model to use | Provider-specific model ID |
| `reasoningEffort` | Extended reasoning level | `none`, `low`, `medium`, `high`, `xhigh` |
| `autoLevel` | Automation/access level | `low`, `medium`, `high` |
| `permissionLevel` | Authorization for CLI/RPC ops | `restricted`, `standard`, `privileged` |
| `sessionPolicy` | Session refresh policy | See [Session Policy](#session-policy) |

### Access Level Mapping

The `autoLevel` setting maps to SDK access permissions:

| autoLevel | Behavior |
|-----------|----------|
| `low` | Read-only filesystem; no writes; web search allowed |
| `medium` | Sandboxed writes; web search; network including localhost |
| `high` | Unrestricted; no sandbox |

## Home Directories

Each agent has provider-specific home directories for configuration and state.

### Structure

```
~/.hiboss/agents/<agent-name>/
├── memory/
│   ├── MEMORY.md        # Long-term memory (file-based)
│   └── daily/
│       └── YYYY-MM-DD.md # Short-term memory (daily logs)
├── codex_home/
│   ├── config.toml      # Copied from ~/.codex/config.toml
│   └── AGENTS.md        # Generated system instructions
└── claude_home/
    ├── settings.json    # Copied from ~/.claude/settings.json
    ├── .claude.json     # Copied from ~/.claude/.claude.json
    └── CLAUDE.md        # Generated system instructions
```

### Setup Functions

Located in `src/agent/home-setup.ts`:

| Function | Purpose |
|----------|---------|
| `setupAgentHome(agentName)` | Creates home directories, copies provider configs |
| `getAgentHomePath(agentName, provider)` | Returns provider-specific home path |
| `getAgentMemoryDir(agentName)` | Returns `~/.hiboss/agents/<name>/memory/` |
| `getAgentMemoryDailyDir(agentName)` | Returns `~/.hiboss/agents/<name>/memory/daily/` |
| `agentHomeExists(agentName)` | Checks if home directories exist |
| `removeAgentHome(agentName)` | Deletes agent home directory |

## Instruction Generation

System instructions define the agent's behavior and context. Instruction files are regenerated each time a new session is created (see [Session Management](session.md#creation)).

On each new session, Hi-Boss injects a truncated snapshot of:
- Long-term memory (`memory/MEMORY.md`)
- Short-term memory (latest 2 `memory/daily/YYYY-MM-DD.md` files)

### Files

- Claude: `~/.hiboss/agents/<name>/claude_home/CLAUDE.md`
- Codex: `~/.hiboss/agents/<name>/codex_home/AGENTS.md`

### Template System

Located in:
- `src/shared/prompt-renderer.ts` (Nunjucks renderer)
- `src/shared/prompt-context.ts` (context builders)
- `src/agent/instruction-generator.ts` (system instructions generation)

- Template language: **Nunjucks** (Jinja-like)
- System entrypoint: `prompts/system/base.md`
- Context variables: see `prompts/VARIABLES.md`

### Functions

| Function | Purpose |
|----------|---------|
| `generateSystemInstructions(ctx)` | Renders template with agent context |
| `writeInstructionFiles(agentName, instructions)` | Writes to both AGENTS.md and CLAUDE.md |
| `readInstructionFile(agentName, provider)` | Reads existing instruction file |

## Agent Execution

### Execution Flow

Located in `src/agent/executor.ts`:

1. **Trigger**: New envelope arrives, a scheduled envelope becomes due, or the daemon starts with pending work
2. **Lock**: Per-agent queue lock acquired (no concurrent runs for same agent)
3. **Session**: Get or create session (see [Session Management](session.md))
4. **Turn Input**: Format pending envelopes into turn input
5. **Execute**: Run agent SDK session with turn input
6. **Auto-Ack**: Mark all envelopes in the run as `done` after a successful run
7. **Audit**: Record run in `agent_runs` table
8. **Reschedule**: If more pending envelopes exist, schedule another turn via `setImmediate`

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_ENVELOPES_PER_TURN` | 10 | Maximum envelopes processed per turn |

### Turn Input Format

Located in `src/agent/turn-input.ts`:

```
## Turn Context

datetime: 2026-01-28T18:30:00.000Z
agent: nex

---
## Pending Envelopes (2)

### Envelope 1

from: channel:telegram:12345
from-name: group "hiboss-test"

Alice (@alice) at 2026-01-28T10:25:00+08:00:
Hello, can you help me?

---

### Envelope 2
...
```

Note: consecutive group-chat envelopes from the same `from:` address are batched under a single `### Envelope <index>` header (header printed once, multiple message lines).

### Auto-Acknowledgment

After a successful agent run, Hi-Boss marks all envelopes included in that run as `done`.

If a run fails, those envelopes remain `pending` and will be retried on the next trigger (new envelope, scheduler tick, or daemon restart recovery).

## Background Tasks

Hi-Boss supports fire-and-forget background execution for an agent, intended for heavy tasks that would otherwise block normal envelope processing.

### CLI Command

```bash
hiboss background --token <agent-token> --task "..."
```

### Behavior

- The daemon resolves `--token` to the corresponding agent and uses that agent's provider/model/auto/workspace configuration.
- The background run uses a temporary copy of the provider home directory and ensures there is no injected system prompt:
  - removes `AGENTS.md` and `CLAUDE.md` from that temporary home
- When the background run completes, Hi-Boss sends a single envelope back to `agent:<agent-name>` whose text is the background agent's final response.

## Agent Bindings

Bindings connect agents to adapters (e.g., Telegram bots).

### Database Schema

Table: `agent_bindings`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT | Primary key |
| agent_name | TEXT | Foreign key to agents |
| adapter_type | TEXT | e.g., "telegram" |
| adapter_token | TEXT | Adapter authentication |
| created_at | TEXT | ISO 8601 |

Constraints:
- Unique on `(adapter_type, adapter_token)` - each adapter binds to one agent
- Each agent can have at most one binding per adapter type

### CLI Commands

```bash
# Bind agent to Telegram bot
hiboss agent set \
  --token <boss-token> \
  --name nex \
  --bind-adapter-type telegram \
  --bind-adapter-token <telegram-bot-token>

# Remove binding
hiboss agent set \
  --token <boss-token> \
  --name nex \
  --unbind-adapter-type telegram
```

### Permissions

- Agents can only send to adapters they're bound to
- Sending to `channel:telegram:...` requires a telegram binding

## Session Policy

Session policies control when agent sessions are refreshed. Stored as a first-class field on the Agent (`agent.sessionPolicy`). For how policies are evaluated at runtime, see [Session Management](session.md#session-policy-evaluation).

### Configuration

```typescript
interface SessionPolicyConfig {
  dailyResetAt?: string;   // "HH:MM" format (24h)
  idleTimeout?: string;    // Duration: "2h", "30m", "1h30m"
  maxTokens?: number;      // Token limit per run
}
```

### CLI Commands

```bash
# Set session policy
hiboss agent set \
  --token <boss-token> \
  --name nex \
  --session-daily-reset-at 09:00 \
  --session-idle-timeout 2h \
  --session-max-tokens 100000

# Clear session policy
hiboss agent set --token <boss-token> --name nex --clear-session-policy
```

## Agent Runs (Auditing)

All agent executions are recorded in the `agent_runs` table.

### Schema

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Primary key |
| agent_name | TEXT | Agent that ran |
| started_at | INTEGER | Unix timestamp (ms) |
| completed_at | INTEGER | Unix timestamp (ms) |
| envelope_ids | TEXT | JSON array of processed envelope IDs |
| final_response | TEXT | Full agent response text |
| status | TEXT | `running`, `completed`, `failed` |
| error | TEXT | Error message if failed |

### Querying Runs

```bash
sqlite3 ~/.hiboss/hiboss.db \
  "SELECT id, agent_name, status, datetime(started_at/1000,'unixepoch')
   FROM agent_runs ORDER BY started_at DESC LIMIT 20;"
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `hiboss agent register --token <boss-token> --name <n> [--description <d>] [--workspace <w>]` | Create agent |
| `hiboss agent set --token <token> --name <n> [options]` | Update agent settings and bindings |
| `hiboss agent list --token <boss-token>` | List all agents with bindings |
| `hiboss background --token <agent-token> --task <text>` | Run a background task and send the final response to `agent:<self>` |

## RPC Methods

Available via daemon IPC:

| Method | Parameters | Description |
|--------|------------|-------------|
| `agent.register` | token, name, description?, workspace?, session policy options | Create agent |
| `agent.set` | token, agentName, updates (settings/binding/session policy/metadata) | Update agent settings and bindings |
| `agent.list` | token | List agents with bindings |
| `agent.bind` | token, agentName, adapterType, adapterToken | Bind adapter |
| `agent.unbind` | token, agentName, adapterType | Remove binding |
| `agent.refresh` | token, agentName | Force session refresh |
| `agent.self` | token | Resolve the token to the current agent config |
| `agent.session-policy.set` | token, agentName, policy options, clear? | Update session policy |

## Key Files

| Component | File |
|-----------|------|
| Types | `src/agent/types.ts` |
| Executor | `src/agent/executor.ts` |
| Home setup | `src/agent/home-setup.ts` |
| Instructions | `src/agent/instruction-generator.ts` |
| Turn input | `src/agent/turn-input.ts` |
| Auth/tokens | `src/agent/auth.ts` |
| CLI commands | `src/cli/commands/agent.ts` |
| Database schema | `src/daemon/db/schema.ts` |
| Validation | `src/shared/validation.ts` |

For session-related files, see [Session Management](session.md#key-files).
