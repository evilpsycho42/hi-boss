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
| `hiboss setup` | Initialize Hi-Boss (interactive first-time bootstrap) | No (bootstrap) | n/a |
| `hiboss daemon start` | Start the daemon | Yes (admin-privileged token) | admin |
| `hiboss daemon stop` | Stop the daemon | Yes (admin-privileged token) | admin |
| `hiboss daemon status` | Show daemon status | Yes (admin-privileged token) | admin |
| `hiboss envelope send` | Send an envelope | Yes (agent token) | restricted |
| `hiboss envelope list` | List envelopes | Yes (agent token) | restricted |
| `hiboss envelope thread` | Show envelope thread | Yes (agent token) | restricted |
| `hiboss cron create` | Create a cron schedule | Yes (agent token) | restricted |
| `hiboss cron explain` | Validate cron + preview upcoming run times | Yes when `--timezone` omitted; otherwise no | n/a |
| `hiboss cron list` | List cron schedules | Yes (agent token) | restricted |
| `hiboss cron enable` | Enable a cron schedule | Yes (agent token) | restricted |
| `hiboss cron disable` | Disable a cron schedule | Yes (agent token) | restricted |
| `hiboss cron delete` | Delete a cron schedule | Yes (agent token) | restricted |
| `hiboss reaction set` | Set a reaction on a channel message | Yes (agent token) | restricted |
| `hiboss agent register` | Register a new agent | Yes (admin-privileged token) | admin |
| `hiboss agent set` | Update agent settings and bindings | Yes (agent/admin token) | privileged |
| `hiboss agent list` | List agents | Yes (agent/admin token) | restricted |
| `hiboss agent status` | Show agent state/health | Yes (agent/admin token) | restricted |
| `hiboss agent abort` | Cancel current run + clear pending inbox | Yes (admin token) | admin |
| `hiboss agent delete` | Delete an agent | Yes (admin-privileged token) | admin |
| `hiboss team register` | Create a team and initialize teamspace | Yes (agent/admin token) | privileged |
| `hiboss team set` | Update team metadata/status | Yes (agent/admin token) | privileged |
| `hiboss team add-member` | Add an agent to a team | Yes (agent/admin token) | privileged |
| `hiboss team remove-member` | Remove an agent from a team | Yes (agent/admin token) | privileged |
| `hiboss team status` | Show one team and its members | Yes (agent/admin token) | restricted |
| `hiboss team list` | List teams | Yes (agent/admin token) | restricted |
| `hiboss team list-members` | List member records for one team | Yes (agent/admin token) | restricted |
| `hiboss team send` | Fan out one message to all active team members (excluding sender) | Yes (agent token) | restricted |
| `hiboss team delete` | Delete a team and remove teamspace | Yes (admin token) | admin |

Note: `hiboss daemon start` prints startup failure guidance directly in CLI when available (for example setup-integrity remediation), and also writes details to `daemon.log`.

---

## Topics

- Setup: `docs/spec/cli/setup.md`
- Daemon: `docs/spec/cli/daemon.md`
- Envelopes: `docs/spec/cli/envelopes.md`
- Cron: `docs/spec/cli/cron.md`
- Reactions: `docs/spec/cli/reactions.md`
- Agents: `docs/spec/cli/agents.md`
- Teams: `docs/spec/cli/teams.md`
