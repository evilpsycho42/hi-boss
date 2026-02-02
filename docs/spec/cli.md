# CLI

This document describes the `hiboss` CLI command surface and how output is rendered for agent-facing and human-facing use.

Implementation references:
- `src/cli/cli.ts` (CLI surface)
- `src/cli/commands/*.ts` (RPC calls + printing)
- `src/cli/instructions/format-envelope.ts` (envelope instruction rendering)
- `src/shared/prompt-renderer.ts` + `src/shared/prompt-context.ts` (prompt system)
- `prompts/` (Nunjucks templates)

---

## Conventions

### Tokens

Many commands accept `--token`; if omitted, the CLI uses the `HIBOSS_TOKEN` environment variable.

### Clearing optional values

Some agent settings are nullable (e.g., `model`, `reasoning-effort`). When cleared, Hi-Boss omits these overrides when opening provider sessions so provider defaults apply.

To clear via CLI, use the sentinel value `default`, for example:
- `hiboss agent set --name <agent> --model default`
- `hiboss agent set --name <agent> --reasoning-effort default`

### Output stability

- Most operational commands print key-value lines like `key: value` with kebab-case keys (intended to be parseable).
- `hiboss setup interactive` prints a wizard with human-friendly prose plus a final key-value summary.
- Envelope instruction output keys and placement are specified in `docs/spec/definitions.md`.

### Provider config import

- When an agent provider is set via CLI, Hi-Boss imports provider config files into the agent’s provider home.
- Source defaults:
  - `codex` → `~/.codex/`
  - `claude` → `~/.claude/`
- Override via `--provider-source-home <path>` on `hiboss agent register` / `hiboss agent set`.

### Daemon dependency

- Commands that call IPC (`envelope.*`, most `agent.*`) require the daemon to be running.

---

## Command Summary

Default permission levels below come from the built-in permission policy (`DEFAULT_PERMISSION_POLICY`).

| Command | Purpose | Token required? | Default permission |
|--------|---------|-----------------|--------------------|
| `hiboss setup` | Initialize Hi-Boss (interactive wizard) | No (bootstrap) | n/a |
| `hiboss setup default` | Initialize Hi-Boss (non-interactive) | No (bootstrap; requires `--config`) | n/a |
| `hiboss daemon start` | Start the daemon | Yes (boss token) | boss |
| `hiboss daemon stop` | Stop the daemon | Yes (boss token) | boss |
| `hiboss daemon status` | Show daemon status | Yes (boss token) | boss |
| `hiboss envelope send` | Send an envelope | Yes (agent token) | restricted |
| `hiboss envelope list` | List envelopes | Yes (agent/boss token) | restricted |
| `hiboss envelope get` | Get an envelope by id | Yes (agent/boss token) | restricted |
| `hiboss cron create` | Create a cron schedule | Yes (agent token) | restricted |
| `hiboss cron list` | List cron schedules | Yes (agent token) | restricted |
| `hiboss cron enable` | Enable a cron schedule | Yes (agent token) | restricted |
| `hiboss cron disable` | Disable a cron schedule | Yes (agent token) | restricted |
| `hiboss cron delete` | Delete a cron schedule | Yes (agent token) | restricted |
| `hiboss reaction set` | Set a reaction on a channel message | Yes (agent token) | restricted |
| `hiboss memory add/search/list/categories/get/delete/delete-category` | Semantic memory operations | Yes (agent token) | restricted |
| `hiboss memory clear` | Clear all semantic memories for an agent | Yes (agent token) | standard |
| `hiboss memory setup` | Configure semantic memory model | Yes (agent/boss token) | privileged |
| `hiboss agent register` | Register a new agent | Yes (boss token) | boss |
| `hiboss agent set` | Update agent settings and bindings | Yes (agent/boss token) | privileged |
| `hiboss agent list` | List agents | Yes (agent/boss token) | restricted |

---

## Topics

- Setup: `docs/spec/cli/setup.md`
- Daemon: `docs/spec/cli/daemon.md`
- Envelopes: `docs/spec/cli/envelopes.md`
- Cron: `docs/spec/cli/cron.md`
- Reactions: `docs/spec/cli/reactions.md`
- Agents: `docs/spec/cli/agents.md`
- Memory: `docs/spec/cli/memory.md`
