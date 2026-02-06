# Session Management

This document describes how Hi-Boss manages agent sessions.

## Overview

Hi-Boss caches sessions **in-memory** for performance, and also persists a **minimal session handle** (thread/session id + metadata) to enable **best-effort resume across daemon restarts** (when the provider supports it).

Envelope delivery remains the priority: if session resume fails (missing/expired session id, provider error, etc), Hi-Boss falls back to starting a fresh session so envelopes still get processed.

## Session Lifecycle

### Creation

Sessions are created on-demand when an agent needs to process envelopes:

1. `AgentExecutor.getOrCreateSession()` checks if a session exists in memory
2. If not (or if refresh is needed), syncs skills for the effective provider (built-ins + globals) into the provider home skills directory
3. Generates fresh instruction files (AGENTS.md/CLAUDE.md) in the agent home directory (including an injected `internal_space/MEMORY.md` snapshot)
4. Creates a new `UnifiedAgentRuntime` with home path pointing to instruction files
5. If the agent has a persisted `sessionHandle` and session policy allows it, attempts `runtime.resumeSession(handle)`
6. If resume is not possible or fails, opens a new session via `runtime.openSession({})`
7. Caches the session in memory by agent name

### Reuse

Existing sessions are reused for subsequent envelope processing, subject to refresh policies.

### Refresh

Sessions are refreshed (disposed and recreated) when:

| Trigger | Description |
|---------|-------------|
| `dailyResetAt` | Configured time of day (e.g., `"09:00"`) |
| `idleTimeout` | No activity for configured duration (e.g., `"2h"`) |
| `maxContextLength` | Context length exceeds threshold (evaluated after a successful run; uses `usage.context_length` when present; skipped when missing) |
| Manual `/new` | Boss sends `/new` command via Telegram |
| Daemon restart | In-memory sessions are lost; Hi-Boss attempts to resume from persisted `sessionHandle` when possible |

### Disposal

Sessions are disposed when:
- Refresh is triggered
- Daemon shuts down

## Storage

### In-Memory (Ephemeral)

Located in `src/agent/executor.ts`:

```typescript
private sessions: Map<string, AgentSession> = new Map();
private agentLocks: Map<string, Promise<void>> = new Map();
private pendingSessionRefresh: Map<string, SessionRefreshRequest> = new Map();
```

Session structure:

```typescript
interface AgentSession {
  runtime: UnifiedAgentRuntime<any, any>;
  session: UnifiedSession<any, any>;
  agentToken: string;
  provider: "claude" | "codex";
  createdAtMs: number;
  lastRunCompletedAtMs?: number;
}
```

### Persistent (Survives Restart)

- **Database** (`~/hiboss/.daemon/hiboss.db`): Agent metadata, envelope queue, bindings, session policies
- **Home directories**: Provider configs and instruction files (see [Agents](agent.md#home-directories))

Session resume uses a small record stored in `agents.metadata.sessionHandle`:

```json
{
  "version": 1,
  "provider": "codex",
  "handle": {
    "provider": "@openai/codex-sdk",
    "sessionId": "<thread id>",
    "metadata": { "...": "..." }
  },
  "createdAtMs": 0,
  "lastRunCompletedAtMs": 0,
  "updatedAtMs": 0
}
```

Notes:
- The record is updated after successful runs (best-effort).
- A manual refresh (`/new`) or policy refresh clears the persisted handle so the next run starts fresh.
- For providers that support it, the `handle.metadata` includes a snapshot of the unified session config (workspace/access/model/reasoning). On resume, the provider may prefer this snapshot over the agent’s current settings. Practically, changing an agent’s `model` / `reasoning-effort` may not affect an already-resumed session until a fresh session is opened.
- If the agent’s configured provider changes while a persisted handle exists, Hi-Boss may still resume the legacy provider session (best-effort) until the session is refreshed.

## Daemon Restart Recovery

When the daemon starts, `processPendingEnvelopes()` handles recovery:

1. Iterates through all registered agents
2. Queries database for pending envelopes
3. Triggers agent runs for any agent with pending work
4. New sessions are created automatically as needed

This ensures no envelopes are lost during daemon downtime.

## Session Policy Evaluation

Session policies are configured per-agent (see [Agents](agent.md#session-policy)).

Before starting a run, `getRefreshReasonForPolicy()` in `src/agent/executor.ts` checks:

1. **Daily reset**: Has the configured reset time passed since session creation?
2. **Idle timeout**: Has the session been inactive longer than the threshold?

If any condition is met, the session is marked for refresh.

After a successful run completes, the daemon may also refresh the session based on `maxContextLength` (context length threshold), so the *next* run starts fresh.

## Concurrency

- Per-agent queue locks ensure no concurrent runs for the same agent
- Multiple agents can run concurrently
- Refresh requests are queued and processed after the current run completes

## Key Files

| File | Purpose |
|------|---------|
| `src/agent/executor.ts` | Session creation, caching, refresh, disposal |
| `src/shared/session-policy.ts` | Policy definitions and parsing |
| `src/daemon/daemon.ts` | Restart recovery via `processPendingEnvelopes()` |

## Design Rationale

**Why ephemeral sessions?**

1. **Simplicity**: No complex session serialization/deserialization
2. **Reliability**: Fresh sessions avoid accumulated state corruption
3. **Envelope guarantee**: Database-backed envelope queue ensures delivery regardless of session state
4. **Policy flexibility**: Easy to implement refresh policies without migration concerns

**Trade-offs:**

- Conversation context is still lost on session refresh, and daemon restart resume is best-effort (may fall back to fresh session)
- Agents must rely on envelope history (via CLI) for continuity, not session memory
