# CLI: MCP

This document specifies `hiboss mcp ...`.

## `hiboss mcp serve`

Runs a stdio MCP server that bridges MCP tool calls to Hi-Boss daemon RPC methods.

Flags:
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Transport:
- Input: JSON-RPC lines from stdin
- Output: JSON-RPC lines to stdout
- Non-protocol logs must go to stderr

Exposed tools:
- `hiboss_agent_list` -> `agent.list`
- `hiboss_session_list` -> `session.list`
- `hiboss_envelope_send` -> `envelope.send`
- `hiboss_envelope_list` -> `envelope.list`

Notes:
- MCP tool authorization is enforced by the same daemon permission policy as CLI RPC calls.
- Use an agent token for normal agent-scoped operations.
- Session targeting for `hiboss_envelope_send` is supported via:
  - `toSessionId` (Hi-Boss session id)
  - `toProviderSessionId` (+ optional `toProvider`)

## Platform constraints

- `hiboss mcp serve` connects to daemon IPC via the local daemon socket (`{{HIBOSS_DIR}}/.daemon/daemon.sock`).
- Therefore MCP server and daemon must run in the same OS/container namespace that can access that socket path.
- On native Windows hosts, this Unix-socket transport is generally not directly usable; run `hiboss mcp serve` inside Linux runtime (Docker/WSL) where daemon is running.

## Cross-machine best practice (Mac <-> Windows)

Recommended topology: single daemon authority (hub), multiple MCP clients.

- Run one Hi-Boss daemon as hub (for your current setup: Windows Docker runtime).
- Run MCP servers as close to that daemon as possible (same container/namespace), each with its own agent token.
- Let Mac/Windows Claude/Codex sessions connect to those MCP servers (local on Windows, SSH-bridged stdio from Mac).

Why this topology:

- Avoids dual-daemon split-brain (separate agent/session namespaces).
- Keeps envelope routing/session pinning consistent because all writes hit one DB/queue authority.
- Keeps operational model simple: one scheduler, one run history, one permission policy.

Suggested access patterns:

- Windows local session -> local MCP:
  - run in runtime namespace: `hiboss mcp serve --token <agent-token>`
- Mac session -> Windows hub MCP (stdio over SSH):
  - example wrapper command:
    - `ssh <windows-or-wsl-host> \"docker exec -i hiboss-daemon node /workspace/dist/bin/hiboss.js mcp serve --token <agent-token>\"`

Operational guidance:

- Use dedicated agent tokens per MCP endpoint/client (least privilege, easy revoke/rotate).
- Do not use admin tokens in MCP client configs.
- Use `hiboss_agent_list` + `hiboss_session_list` to discover targets before send.
- For deterministic delivery to an existing conversation, prefer:
  - `toSessionId`, or
  - `toProviderSessionId` (+ optional `toProvider`).
