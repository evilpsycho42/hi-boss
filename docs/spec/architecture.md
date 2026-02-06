# Architecture

This document is a high-level view of Hi-Boss. For details, see the linked spec docs.

## Big Picture

```
┌──────────────┐     ┌───────────────┐     ┌──────────────────────┐
│  Chat Apps   │────▶│   Adapters    │────▶│      Daemon          │
│ (Telegram…)  │     │ (Telegram…)   │     │  (router + scheduler │
└──────────────┘     └───────────────┘     │   + agent executor)  │
                                           └──────────┬───────────┘
                                                      │
                                           persists   │   JSON-RPC
                                                      │   (local socket)
                                     ┌────────────────┼────────────────┐
                                     ▼                                 ▼
                             ┌───────────────┐                 ┌──────────────┐
                             │    SQLite     │                 │   hiboss     │
                             │  hiboss.db    │                 │    CLI       │
                             └───────────────┘                 └──────────────┘
```

## Components

| Component | Responsibility | Specs |
|----------|----------------|------|
| Daemon | Owns state, routes envelopes, runs agents, manages adapters | `docs/spec/components/routing.md` |
| SQLite DB | Durable queue + audit (agents, bindings, envelopes, runs, config) | `docs/spec/definitions.md` |
| Scheduler | Wakes future `deliver-at` envelopes and triggers delivery | `docs/spec/components/scheduler.md` |
| Agent executor | Syncs managed skills on new sessions, runs provider sessions, and marks envelopes done | `docs/spec/components/agent.md`, `docs/spec/components/session.md` |
| CLI | Talks to daemon over IPC for ops + envelopes | `docs/spec/ipc.md` |
| Adapters | Bridge external systems to channel messages/commands | `docs/spec/adapters/telegram.md` |

## Key Invariants

- **Daemon owns state**: the CLI is a client; the daemon is the authority.
- **Envelope persistence**: envelopes live in SQLite and are the durable queue.
- **Token-gated envelope operations**: envelope RPC requires an agent token (see `docs/spec/ipc.md`).
- **Scheduling is delivery-time, not execution-time**: `--deliver-at` controls *when* an envelope becomes due.
- **Stable parseable outputs**: CLI output keys and agent instruction keys remain kebab-case and stable (see `docs/spec/definitions.md`).
