# Envelopes

An **envelope** is Hi-Boss’s internal message record. Every message between:

- a **human** (via an adapter like Telegram) and an **agent**, or
- an **agent** and another **agent**, or
- an **agent** and a **channel**

is represented as an envelope stored in SQLite (`~/.hiboss/hiboss.db`, table: `envelopes`).

---

## Addressing

| Destination type | Address format | Example |
|------------------|----------------|---------|
| Agent | `agent:<name>` | `agent:nex` |
| Channel | `channel:<adapter>:<chat-id>` | `channel:telegram:6447779930` |

---

## Envelope Fields

Defined in `src/envelope/types.ts` and persisted in `src/daemon/db/schema.ts`.

Key fields:

- `from`: sender address (agent or channel)
- `to`: destination address (agent or channel)
- `fromBoss`: `true` if the sender matches configured boss identity for that adapter (channel messages only)
- `createdAt`: when the envelope was created (ISO 8601 UTC)
- `status`: `pending` or `done`
- `deliverAt` (optional): not-before delivery timestamp (stored as UTC ISO 8601)
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
- If `deliver-at` is in the **future**, the envelope remains `pending` until the scheduler wakes it up (see `docs/spec/scheduler.md`).

### When does an envelope become `done`?

- **To an agent**: the envelope stays `pending` until the agent runs successfully; after a successful run, the daemon marks all envelopes in that run as `done` (`src/agent/executor.ts`).
- **To a channel**: the daemon marks the envelope as `done` after a successful adapter send (`src/daemon/router/message-router.ts`).

If delivery/run fails, the envelope generally remains `pending` and will be retried by later triggers (new activity, scheduler tick, daemon restart recovery).

---

## CLI Usage

### Send

```bash
hiboss envelope send --to agent:nex --token <agent-token> --text "hello"
```

Boss token can also send envelopes, but must provide an explicit sender address:

```bash
hiboss envelope send --to agent:nex --token <boss-token> --from channel:telegram:12345 --text "hello"
```

With scheduling:

```bash
hiboss envelope send --to agent:nex --token <agent-token> --text "reminder" --deliver-at +2h
```

Multiline text (recommended):

```bash
hiboss envelope send --to agent:nex --token <agent-token> --text - <<'EOF'
line 1
line 2
EOF
```

Attachments (repeatable):

```bash
hiboss envelope send --to agent:nex --token <agent-token> --text "see attached" \
  --attachment ./report.pdf \
  --attachment ./diagram.png
```

### List / Get

```bash
hiboss envelope list --token <agent-token> --box inbox --status pending -n 10
hiboss envelope get --id <envelope-id> --token <agent-token>
```

Boss token can list envelopes for any address by providing `--address`:

```bash
hiboss envelope list --token <boss-token> --address agent:nex --box inbox --status pending -n 10
```

`hiboss envelope list` and `hiboss envelope get` output an agent-facing “instruction” format. Direct/agent messages use `text:` (and optional `attachments:`); group messages use `Author [boss] at timestamp:` lines (and optional `attachments:`). For the exact keys, see `docs/spec/definitions.md`.

If you want a token-efficient format that matches what agents receive during a run, use:

```bash
hiboss envelope list --as-turn --token <agent-token>
```

If `envelope list` returns no results, it outputs:

```
no-envelopes: true
```

---

## Permissions

Sending **to a channel** (e.g. `channel:telegram:...`) is only allowed if the sending agent is bound to that adapter type. The daemon enforces this at `envelope.send`.

---

## Scheduling (`--deliver-at`)

`--deliver-at` accepts:

- **Relative time**: `+2h`, `+30m`, `+1Y2M3D`, `-15m` (units are case-sensitive: `Y/M/D/h/m/s`)
- **ISO 8601**: `2026-01-27T16:30:00+08:00` (or UTC `Z`)

The daemon parses the input and stores `deliver-at` as a UTC ISO timestamp.

See `docs/spec/scheduler.md` for delivery behavior and wake-up logic.
