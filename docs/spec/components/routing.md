# Routing & Envelope Flow

Hi-Boss routes all messages as envelopes through the daemon and persists them in SQLite.

Key files:

- `src/daemon/daemon.ts`
- `src/daemon/bridges/channel-bridge.ts`
- `src/daemon/router/message-router.ts`
- `src/daemon/scheduler/envelope-scheduler.ts`
- `src/agent/executor.ts`

## Inbound Flow (Telegram -> Agent)

1. Telegram update -> `TelegramAdapter` emits `ChannelMessage`.
2. `ChannelBridge` resolves bound agent and creates envelope:
   - `from: channel:telegram:<chat-id>`
   - `to: agent:<agent-name>`
3. Envelope is persisted as `pending`.
4. Agent handler triggers `executor.checkAndRun(...)`.
5. Executor reads due envelopes, groups by session scope, marks read envelopes `done`, and schedules per-session execution.

## Session-aware Agent Routing

Session scope resolution:

- Agent source + `metadata.chatScope`: resolve default session via `channel_session_bindings` using `adapter_type="internal"` and `chat_id=metadata.chatScope`.
- Channel source (`from = channel:<adapter>:<chat-id>`): resolve default session via `channel_session_bindings`.
- Agent source without `chatScope` (legacy/cron inline): use default per-agent scope.

Execution semantics:

- same session id => serial execution
- different session ids => can run in parallel (subject to configured limits)

## Agent-to-Agent Flow

Agent-origin addressing in `envelope.send`:

- `--to agent:<name>:new`
  - daemon canonicalizes agent names
  - stamps `metadata.chatScope = agent-chat-...` (generated)
  - creates one envelope
- `--to agent:<name>:<chat-id>`
  - daemon canonicalizes agent names
  - stamps `metadata.chatScope = <chat-id>`
  - creates one envelope
- `--to team:<name>`
  - daemon validates active team
  - fans out one envelope per member excluding sender
  - each envelope targets `agent:<member>` and stamps `metadata.chatScope = team:<name>`
- `--to team:<name>:<agent>`
  - daemon validates active team + membership
  - creates one envelope to the mentioned member
  - stamps `metadata.chatScope = team:<name>`

`--interrupt-now` is allowed only for single-agent destinations (`agent:<name>:new`, `agent:<name>:<chat-id>`, `team:<name>:<agent>`), not for `team:<name>` broadcast.

## Outbound Flow (Agent -> Channel)

1. Agent sends envelope to `channel:<adapter>:<chat-id>`.
2. Router validates binding and resolves adapter.
3. For Telegram, optional quote/reply resolution uses `replyToEnvelopeId` when same adapter+chat route exists.
4. Adapter sends platform message; envelope is marked `done` on success.

## Telegram Command Routing

Boss-only command flow:

1. Telegram command/callback -> `TelegramAdapter` emits `ChannelCommand`.
2. `ChannelBridge` enforces boss identity and binds `agentName`.
3. `createChannelCommandHandler(...)` handles command:
   - `/status`
   - `/trace` (current run trace snapshot)
   - `/abort`
   - `/new` (current chat -> fresh session)
   - `/sessions` (tabbed, paged session list)
   - `/session <id>` (switch current chat mapping)
   - `/provider <claude|codex> [model=<name|default>] [reasoning-effort=<none|low|medium|high|xhigh|default>]` (switch provider and/or provider overrides + request full session refresh on change)
   - `/isolated`, `/clone` (one-shot; default mapping unchanged)
4. Adapter replies in parseable text format; `/sessions` includes inline keyboard for tabs/pager.

## Scheduled Delivery

Scheduled envelopes use the same routing path:

- due channel envelopes are delivered by scheduler
- due agent envelopes trigger executor scheduling

See `docs/spec/components/scheduler.md` for wake-up details.
