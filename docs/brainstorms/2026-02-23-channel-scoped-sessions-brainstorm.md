---
date: 2026-02-23
topic: channel-scoped-sessions
---

# Channel-Scoped Sessions Brainstorm

## What We're Building

We are moving from a single active session per agent to channel-scoped active sessions, where each `channel:<adapter>:<chat-id>` can have its own active session mapping. Multiple chats may intentionally point to the same session id. Non-channel sources keep a default per-agent session bucket.

Telegram gets new boss-only controls:

- `/sessions` to browse recent sessions with inline tabs and pager
- `/session <id>` to switch current chat active session
- `/new` to create and switch current chat to a fresh session

The execution model becomes session-aware:

- cross-session: parallel
- same session: strictly serial
- bounded by configurable limits (default per-agent 4, global 16)

## Why This Approach

This keeps the existing envelope/routing model intact while introducing an explicit durable session registry (`agent_sessions`, `channel_session_bindings`, `channel_session_links`).

Benefits:

- better isolation across chats
- optional context sharing by explicit remap
- deterministic serial order inside one conversation
- improved throughput with bounded parallelism

Tradeoff accepted:

- more DB/state complexity than single-session design

## Key Decisions

- `/sessions` tabs: `current-chat`, `my-chats` (by Telegram user id), `agent-all`
- `/sessions` pagination: fixed 10 per page, up to 100 items
- `/session <id>` accepts short-id / prefix semantics
- `/clone` and `/isolated` remain one-shot and do not mutate active mapping
- one-shot final response includes `execution-session-id`
- settings runtime adds `session-concurrency` defaults and bounds

## Resolved Questions

- Should scope include all adapters? Yes, all `channel:*` adapters use channel-scoped mapping.
- Should runs be parallel? Yes, all sessions can run concurrently with limits.
- Should same-session runs be parallel? No, same-session strict serialization.

## Open Questions

- None at brainstorm close.

## Next Steps

- Implement schema + DB APIs
- Refactor executor to session-aware scheduling
- Add Telegram command and callback UX
- Add/adjust tests and spec docs
