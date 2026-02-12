# Envelopes

An **envelope** is Hi-Boss’s internal durable message record (SQLite table: `envelopes`).

Every message between:
- a human (via an adapter like Telegram) and an agent
- an agent and another agent
- an agent and a channel

is represented as an envelope that the daemon routes and eventually terminalizes (`status=done`).

---

## Addressing (canonical)

See:
- `docs/spec/definitions.md#addresses`
- `src/adapters/types.ts` (`parseAddress`)

---

## Fields (canonical)

Field mappings live in:
- `docs/spec/definitions.md` (TypeScript ↔ SQLite ↔ CLI output keys)
- `src/envelope/types.ts`
- `src/daemon/db/schema.ts`

---

## Lifecycle (canonical)

### Creation

Envelopes are created by:
- Adapters → daemon (e.g., Telegram inbound messages), via `src/daemon/bridges/channel-bridge.ts`
- Agents → daemon, via `hiboss envelope send` / `envelope.send`

New envelopes start as `status=pending`.

### Scheduling (`deliverAt`)

Scheduling is “not-before delivery”.

See:
- Parsing + wake-up logic: `docs/spec/components/scheduler.md`
- Due check: `src/shared/time.ts` (`isDueUnixMs`)

### When does an envelope become `done`?

Envelopes are **at-most-once**: once acknowledged as read/delivered they are terminalized and not retried.

- To an agent (agent run): marked `done` immediately after read (`src/agent/executor.ts`).
- To an agent (manual read): listing **incoming** pending envelopes is treated as an ACK (see `docs/spec/cli/envelopes.md` and `src/daemon/rpc/envelope-handlers.ts`).
- To a channel: marked `done` after an adapter send attempt (`src/daemon/router/message-router.ts`); failures are terminal and recorded in `metadata.lastDeliveryError`.

Permission note:
- Sending to `channel:<adapter>:...` is only allowed if the sending agent is bound to that adapter type (enforced in `envelope.send`).

---

## Reply / Threading (canonical)

Hi-Boss uses a single reply/thread mechanism for both:
- channel quoting (e.g., Telegram “reply”)
- agent↔agent context threading (task/subtask trees)

Mechanism:
- `hiboss envelope send --reply-to <envelope-id>` sets `envelope.metadata.replyToEnvelopeId` on the new envelope.
- `hiboss envelope thread --envelope-id <id>` follows `metadata.replyToEnvelopeId` pointers from the target envelope up to the root envelope.
- For channel destinations, adapters may additionally use the referenced envelope’s internal channel message id to set platform-native quoting/reply behavior.

Notes:
- Platform message ids (e.g., Telegram `message_id`) are stored in `envelope.metadata.channelMessageId` but are intentionally not shown to agents.
- Legacy direct platform reply-id metadata (for example `metadata.replyToMessageId`) is ignored at runtime.
