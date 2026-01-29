# IPC (CLI ↔ daemon)

Hi-Boss uses local IPC so the `hiboss` CLI can talk to the running daemon.

Key files:

- `src/daemon/ipc/server.ts` — JSON-RPC server over a local socket
- `src/cli/ipc-client.ts` — JSON-RPC client used by the CLI
- `src/daemon/ipc/types.ts` — method params/result types and error codes
- `src/daemon/daemon.ts` — method implementations

---

## Transport

- Socket path: `~/.hiboss/daemon.sock` (under the data dir)
- Protocol: JSON-RPC 2.0

---

## Authentication model

Envelope RPC methods require an **agent token**:

- the CLI passes `token` in params (or uses `HIBOSS_TOKEN` when `--token` is omitted)
- the daemon validates it via `agents.token`

Most non-envelope RPC methods are local-admin style and do not require a token (the daemon is intended to be local-only).

---

## RPC Methods (current)

Canonical envelope methods:

- `envelope.send`
- `envelope.list`
- `envelope.get`

Backwards-compatible aliases:

- `message.send`
- `message.list`
- `message.get`

Agents:

- `agent.register`
- `agent.list`
- `agent.bind`
- `agent.unbind`
- `agent.refresh` (requests a session refresh)
- `agent.session-policy.set`

Daemon:

- `daemon.status`
- `daemon.ping`

Setup:

- `setup.check`
- `setup.execute`

Boss:

- `boss.verify`

