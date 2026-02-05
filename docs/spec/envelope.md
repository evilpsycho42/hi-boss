# Envelopes

An **envelope** is Hi-Boss’s internal message record. Every message between:

- a **human** (via an adapter like Telegram) and an **agent**, or
- an **agent** and another **agent**, or
- an **agent** and a **channel**

is represented as an envelope stored in SQLite (`~/hiboss/.daemon/hiboss.db`, table: `envelopes`).

---

## Addressing

| Destination type | Address format | Example |
|------------------|----------------|---------|
| Agent | `agent:<name>` | `agent:nex` |
| Channel | `channel:<adapter>:<chat-id>` | `channel:telegram:6447779930` |

Validation rules:
- `agent:<name>`: `<name>` must be non-empty and match the agent name rules (alphanumeric with hyphens; see `src/shared/validation.ts`).
- `channel:<adapter>:<chat-id>`:
  - `<adapter>` must be non-empty and match `^[a-z][a-z0-9-]*$`
  - `<chat-id>` must be non-empty (trimmed)

---

## Envelope Fields

Defined in `src/envelope/types.ts` and persisted in `src/daemon/db/schema.ts`.

Key fields:

- `from`: sender address (agent or channel)
- `to`: destination address (agent or channel)
- `fromBoss`: `true` if the sender matches configured boss identity for that adapter (channel messages only)
- `createdAt`: when the envelope was created (unix epoch ms UTC)
- `status`: `pending` or `done`
- `deliverAt` (optional): not-before delivery timestamp (stored as unix epoch ms UTC)
- `content.text` (optional)
- `content.attachments` (optional): list of `{ source, filename?, telegramFileId? }`
- `metadata` (optional): channel metadata for richer display (author/chat)

---

## Lifecycle (Status + Delivery)

### Creation

Envelopes are created by:

- **Adapters → daemon** (e.g., Telegram inbound messages), via `ChannelBridge` (`src/daemon/bridges/channel-bridge.ts`)
- **Agents → daemon** via `hiboss envelope send` (IPC method `envelope.send`)

New envelopes are stored as `status = pending`.

### Immediate vs scheduled delivery

- If `deliver-at` is **missing** or **due** (`<= now`), the daemon attempts immediate delivery.
- If `deliver-at` is in the **future**, the envelope remains `pending` until the scheduler wakes it up (see `docs/spec/components/scheduler.md`).

### When does an envelope become `done`?

- **To an agent**: the daemon marks the envelope `done` immediately after it is read for an agent run (`src/agent/executor.ts`). This is **at-most-once**: if the agent run fails, the envelope will not be retried.
- **To an agent (manual read)**: `hiboss envelope list --from <address> --status pending` is also treated as a read; listed envelopes are immediately marked `done` (at-most-once).
- **To a channel**: the daemon marks the envelope as `done` after a successful adapter send (`src/daemon/router/message-router.ts`). If delivery fails, the envelope is also marked `done` (terminal) and the failure is recorded in `last-delivery-error-*`.

Hi-Boss does **not** auto-retry failed channel deliveries. If an **agent run** fails, already-read envelopes stay `done` (no retry).

---

## CLI (quick use)

See `docs/spec/cli/envelopes.md` for the full command surface and output behavior.

Send:

```bash
hiboss envelope send --to agent:nex --token <agent-token> --text "hello"
```

Schedule delivery:

```bash
hiboss envelope send --to agent:nex --token <agent-token> --text "reminder" --deliver-at +2h
```

List pending inbox:

```bash
hiboss envelope list --token <agent-token> --from channel:telegram:<chat-id> --status pending --limit 10
```

Notes:
- Boss tokens cannot send envelopes via `hiboss envelope send` (use an agent token, or message the agent via a channel adapter like Telegram).
- Boss tokens cannot list envelopes via `hiboss envelope list` (use an agent token).

## Permissions

Sending **to a channel** (e.g. `channel:telegram:...`) is only allowed if the sending agent is bound to that adapter type. The daemon enforces this at `envelope.send`.

---

## Scheduling (`--deliver-at`)

`--deliver-at` accepts:

- **Relative time**: `+2h`, `+30m`, `+1Y2M3D`, `-15m` (units are case-sensitive: `Y/M/D/h/m/s`)
- **ISO 8601**: `2026-01-27T16:30:00+08:00` (or UTC `Z`)

The daemon parses the input and stores `deliver-at` as unix epoch milliseconds (UTC).

See `docs/spec/components/scheduler.md` for delivery behavior and wake-up logic.
