# IPC (CLI ↔ daemon)

Hi-Boss uses local IPC so the `hiboss` CLI can talk to the running daemon.

Key files:

- `src/daemon/ipc/server.ts` — JSON-RPC server over a local socket
- `src/cli/ipc-client.ts` — JSON-RPC client used by the CLI
- `src/daemon/ipc/types.ts` — method params/result types and error codes
- `src/daemon/daemon.ts` — method implementations

---

## Transport

- Socket path: `~/hiboss/.daemon/daemon.sock` (or `{{HIBOSS_DIR}}/.daemon/daemon.sock` when overridden)
- Protocol: JSON-RPC 2.0

---

## Authentication model

Most RPC methods require a **token** (agent or admin):

- the CLI passes `token` in params (or uses `HIBOSS_TOKEN` when `--token` is omitted)
- the daemon treats it as an **admin token** if it matches `config.admin_token_hash`, otherwise as an **agent token** (`agents.token`)

Bootstrap methods do not require a token:

- `setup.check`
- `setup.execute`
- `admin.verify`

All other methods require a token and are authorized by the permission policy (see `docs/spec/configuration.md`).

---

## RPC Methods (current)

Canonical envelope methods:

- `envelope.send`
- `envelope.list`
- `envelope.thread`

`envelope.send` notable params:
- `interruptNow?: boolean` (agent destinations only; mutually exclusive with `deliverAt`; interrupts current work and prioritizes the new envelope)
- `toSessionId?: string` (agent destinations only; pin target execution to a specific Hi-Boss session)
- `toProviderSessionId?: string` + `toProvider?: "claude" | "codex"` (agent destinations only; pin by provider session/thread id)
- `origin?: "cli" | "internal"` (optional audit source; defaults to `cli` when omitted)

Reactions:

- `reaction.set`

Cron:

- `cron.create`
- `cron.list`
- `cron.enable`
- `cron.disable`
- `cron.delete`

Backwards-compatible aliases:

None.

Agents:

- `agent.register`
- `agent.set`
- `agent.list`
- `agent.bind`
- `agent.unbind`
- `agent.refresh` (requests a session refresh)
- `agent.abort` (cancels current run + clears due pending non-cron envelopes)
- `agent.self` (resolve `token` → current agent config)
- `agent.session-policy.set`
- `agent.status`

Teams:

- `team.register`
- `team.set`
- `team.add-member`
- `team.remove-member`
- `team.status`
- `team.list`
- `team.list-members`
- `team.send`
- `team.delete`

`team.list-members` params/result:
- params: `token`, `teamName`
- result: `teamName`, `members[]` (`agentName`, `source`, `createdAt`)

`team.send` params/result:
- params: `token`, `teamName`, `text?`, `attachments?`, `deliverAt?`, `interruptNow?`, `replyToEnvelopeId?`, `toSessionId?`, `toProviderSessionId?`, `toProvider?`, `origin?`
- result: `teamName`, `requestedCount`, `sentCount`, `failedCount`, `results[]`
- semantics: fan-out singlecast to each team member (excluding sender), best-effort across recipients

Sessions:

- `session.list`

Daemon:

- `daemon.status`
- `daemon.ping`
- `daemon.time`

Setup:

- `setup.check`
- `setup.execute`

Admin:

- `admin.verify`
