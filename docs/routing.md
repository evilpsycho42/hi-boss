# Routing & Envelope Flow

Hi-Boss routes all messages as **envelopes** through the daemon. The daemon owns persistence and delivery guarantees via SQLite (`~/.hiboss/hiboss.db`).

Key implementation files:

- `src/daemon/daemon.ts` — wires everything together (IPC, DB, adapters, scheduler, agent execution)
- `src/daemon/bridges/channel-bridge.ts` — converts adapter messages → envelopes
- `src/daemon/router/message-router.ts` — creates and delivers envelopes
- `src/daemon/scheduler/envelope-scheduler.ts` — wakes scheduled envelopes and triggers agent runs
- `src/agent/executor.ts` — runs agents and marks envelopes `done`

---

## Components

### Daemon (the orchestrator)

The daemon owns:

- **DB**: agents, bindings, envelopes, agent run audit
- **IPC**: local JSON-RPC over `~/.hiboss/daemon.sock` (used by `hiboss` CLI)
- **Adapters**: e.g. Telegram bots
- **Routing**: `MessageRouter`
- **Channel bridge**: `ChannelBridge`
- **Scheduling**: `EnvelopeScheduler`
- **Agent runtime**: `AgentExecutor`

### Adapters

Adapters provide two main streams into the daemon:

- `ChannelMessage` (chat messages)
- `ChannelCommand` (e.g. Telegram `/new`)

See `docs/adapters/telegram.md`.

---

## Envelope Flow (Inbound)

### Telegram → Agent

1. User sends a message in Telegram.
2. `TelegramAdapter` creates a `ChannelMessage` (text + optional attachments).
3. `ChannelBridge.handleChannelMessage()`:
   - Finds which agent is bound to that bot token (`agent_bindings`)
   - Computes `from-boss` by comparing the sender username with `config.adapter_boss_id_telegram`
   - Creates an envelope:
     - `from = channel:telegram:<chat-id>`
     - `to = agent:<bound-agent-name>`
     - `metadata = { platform, channelMessageId, author, chat }`
4. `MessageRouter.routeEnvelope()` persists the envelope in SQLite (`status = pending`).
5. If the envelope is due now (no `deliver-at`, or `deliver-at <= now`), the router calls `deliverEnvelope()`.
6. For agent destinations, `deliverToAgent()` triggers the registered handler, which calls `AgentExecutor.checkAndRun(...)`.
7. `AgentExecutor` loads pending envelopes from SQLite and runs the agent. After a successful run it marks the processed envelopes as `done`.

If no binding exists:

- The message is dropped.
- If `from-boss: true`, the adapter receives a “not-configured” message telling you how to bind an agent.

---

## Envelope Flow (Outbound)

### Agent → Telegram

1. Agent sends an envelope using `hiboss envelope send --to channel:telegram:<chat-id> ...`
2. Daemon validates permissions:
   - The sender is the agent identified by the token
   - That agent has a binding for `adapter-type = telegram`
3. `MessageRouter.routeEnvelope()` persists the envelope.
4. If due now, the router calls `deliverToChannel()`:
   - Looks up the adapter by binding token
   - Calls `adapter.sendMessage(chatId, { text, attachments })`
   - On success, sets `status = done`

---

## Scheduled Delivery

Scheduled delivery uses the same envelope record, but delays actual delivery until `deliver-at` is due.

- When an envelope is created with a future `deliver-at`, the router stores it as `pending` and does not deliver it immediately.
- `EnvelopeScheduler` wakes up at the next scheduled time and:
  - delivers due channel envelopes (via `router.deliverEnvelope(...)`)
  - triggers agent runs for agents with due envelopes (via `executor.checkAndRun(...)`)

See `docs/scheduler.md` for the exact wake-up algorithm.

---

## `/new` Session Refresh (Telegram)

1. User sends `/new` to the Telegram bot.
2. `TelegramAdapter` emits a `ChannelCommand { command: "new", ... }` and replies `Session refresh requested.`
3. `ChannelBridge` resolves which agent is bound to that bot token and enriches the command with `agentName`.
4. `Daemon` receives the command and calls `AgentExecutor.requestSessionRefresh(agentName, "telegram:/new")`.
5. The refresh is applied at the next safe point (before the next run, or after the current queue drains).

