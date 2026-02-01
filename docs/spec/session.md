# Session Management

This document describes how Hi-Boss manages agent sessions.

## Overview

Hi-Boss uses **stateless/ephemeral session management**. Sessions exist only in memory and are not persisted across daemon restarts. This design prioritizes envelope delivery guarantees over session continuity.

## Session Lifecycle

### Creation

Sessions are created on-demand when an agent needs to process envelopes:

1. `AgentExecutor.getOrCreateSession()` checks if a session exists in memory
2. If not (or if refresh is needed), generates fresh instruction files (AGENTS.md/CLAUDE.md) to home directory (including injected memory snapshot)
3. Creates a new `UnifiedAgentRuntime` with home path pointing to instruction files
4. Opens a `UnifiedSession` via `runtime.openSession({})` which loads instructions from home directory
5. Caches the session in memory by agent name

### Reuse

Existing sessions are reused for subsequent envelope processing, subject to refresh policies.

### Refresh

Sessions are refreshed (disposed and recreated) when:

| Trigger | Description |
|---------|-------------|
| `dailyResetAt` | Configured time of day (e.g., `"09:00"`) |
| `idleTimeout` | No activity for configured duration (e.g., `"2h"`) |
| `maxTokens` | Token usage exceeds threshold (uses `total_usage` when available) |
| Manual `/new` | User sends `/new` command via Telegram |
| Daemon restart | All sessions are lost and recreated as needed |

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

- **Database** (`~/.hiboss/hiboss.db`): Agent metadata, envelope queue, bindings, session policies
- **Home directories**: Provider configs and instruction files (see [Agent System](agent.md#home-directories))

## Daemon Restart Recovery

When the daemon starts, `processPendingEnvelopes()` handles recovery:

1. Iterates through all registered agents
2. Queries database for pending envelopes
3. Triggers agent runs for any agent with pending work
4. New sessions are created automatically as needed

This ensures no envelopes are lost during daemon downtime.

## Session Policy Evaluation

Session policies are configured per-agent (see [Agent System](agent.md#session-policy)). Before reusing a session, `getRefreshReasonForPolicy()` in `src/agent/executor.ts` checks:

1. **Daily reset**: Has the configured reset time passed since session creation?
2. **Idle timeout**: Has the session been inactive longer than the threshold?

If any condition is met, the session is marked for refresh.

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

- Conversation context is lost on session refresh or daemon restart
- Agents must rely on envelope history (via CLI) for continuity, not session memory
