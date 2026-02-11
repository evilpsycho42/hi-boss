# CLI

This document describes the `hiboss` CLI command surface and how output is rendered for agent-facing and human-facing use.

Implementation references:
- `src/cli/cli.ts` (CLI surface)
- `src/cli/commands/*.ts` (RPC calls + printing)
- `src/cli/instructions/format-envelope.ts` (envelope instruction rendering)
- `src/shared/prompt-renderer.ts` + `src/shared/prompt-context.ts` (prompt system)
- `prompts/` (Nunjucks templates)

---

See also:
- CLI conventions (tokens, IDs, output stability): `docs/spec/cli/conventions.md`
- Canonical output keys: `docs/spec/definitions.md`

---

## Command Summary

Default permission levels below come from the built-in permission policy (`DEFAULT_PERMISSION_POLICY`).

| Command | Purpose | Token required? | Default permission |
|--------|---------|-----------------|--------------------|
| `hiboss setup` | Initialize Hi-Boss (interactive wizard) | No (bootstrap) | n/a |
| `hiboss setup --config-file <path>` | Initialize Hi-Boss (non-interactive) | No (bootstrap; requires config file) | n/a |
| `hiboss daemon start` | Start the daemon | Yes (boss-privileged token) | boss |
| `hiboss daemon stop` | Stop the daemon | Yes (boss-privileged token) | boss |
| `hiboss daemon status` | Show daemon status | Yes (boss-privileged token) | boss |
| `hiboss envelope send` | Send an envelope | Yes (agent token) | restricted |
| `hiboss envelope list` | List envelopes | Yes (agent token) | restricted |
| `hiboss cron create` | Create a cron schedule | Yes (agent token) | restricted |
| `hiboss cron list` | List cron schedules | Yes (agent token) | restricted |
| `hiboss cron enable` | Enable a cron schedule | Yes (agent token) | restricted |
| `hiboss cron disable` | Disable a cron schedule | Yes (agent token) | restricted |
| `hiboss cron delete` | Delete a cron schedule | Yes (agent token) | restricted |
| `hiboss reaction set` | Set a reaction on a channel message | Yes (agent token) | restricted |
| `hiboss agent register` | Register a new agent | Yes (boss-privileged token) | boss |
| `hiboss agent set` | Update agent settings and bindings | Yes (agent/boss token) | privileged |
| `hiboss agent list` | List agents | Yes (agent/boss token) | restricted |
| `hiboss agent status` | Show agent state/health | Yes (agent/boss token) | restricted |
| `hiboss agent abort` | Cancel current run + clear pending inbox | Yes (boss token) | boss |
| `hiboss agent delete` | Delete an agent | Yes (boss-privileged token) | boss |

---

## Topics

- Setup: `docs/spec/cli/setup.md`
- Daemon: `docs/spec/cli/daemon.md`
- Envelopes: `docs/spec/cli/envelopes.md`
- Cron: `docs/spec/cli/cron.md`
- Reactions: `docs/spec/cli/reactions.md`
- Agents: `docs/spec/cli/agents.md`
