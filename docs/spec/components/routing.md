# Routing & Envelope Flow

Hi-Boss routes all messages as envelopes through the daemon and persists them in SQLite.

Key files:

- `src/daemon/daemon.ts`
- `src/daemon/bridges/channel-bridge.ts`
- `src/daemon/router/message-router.ts`
- `src/daemon/scheduler/envelope-scheduler.ts`
- `src/agent/executor.ts`

## Inbound Flow (Channel -> Agent)

1. Channel adapter update (for example Telegram or WeChatPadPro) -> adapter emits `ChannelMessage`.
2. `ChannelBridge` resolves bound agent and creates envelope:
   - `from: channel:<adapter>:<chat-id>`
   - `to: agent:<agent-name>`
3. Envelope is persisted as `pending`.
4. Agent handler triggers `executor.checkAndRun(...)`.
5. Executor reads due envelopes, groups by session scope, marks read envelopes `done`, and schedules per-session execution.

## Session-aware Agent Routing

Session scope resolution:

- Channel source (`from = channel:<adapter>:<chat-id>`): resolve active session via `channel_session_bindings`.
- Non-channel source: use default per-agent scope.

Execution semantics:

- same session id => serial execution
- different session ids => can run in parallel (subject to configured limits)

## Outbound Flow (Agent -> Channel)

1. Agent sends envelope to `channel:<adapter>:<chat-id>`.
2. Router validates binding and resolves adapter.
3. For Telegram, optional quote/reply resolution uses `replyToEnvelopeId` when same adapter+chat route exists.
4. Adapter sends platform message; envelope is marked `done` on success.

## Channel Command Routing

Boss-only command flow:

1. Adapter command event -> adapter emits `ChannelCommand`.
2. `ChannelBridge` enforces boss identity and binds `agentName`.
3. `createChannelCommandHandler(...)` handles command:
   - `/status`
   - `/abort`
   - `/new` (current chat -> fresh session)
   - `/sessions` (tabbed, paged session list)
   - `/session <id>` (switch current chat mapping)
   - `/isolated`, `/clone` (one-shot; active mapping unchanged)
4. Adapter replies in parseable text format.
   - Telegram includes inline keyboard for tabs/pager.
   - WeChatPadPro uses text-only args (`tab=... page=...` or `--tab ... --page ...`).

## Scheduled Delivery

Scheduled envelopes use the same routing path:

- due channel envelopes are delivered by scheduler
- due agent envelopes trigger executor scheduling

See `docs/spec/components/scheduler.md` for wake-up details.
