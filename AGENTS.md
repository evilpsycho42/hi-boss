# Hi-Boss Agent Development Guide

> **IMPORTANT:** After completing any code changes, always run:
> ```bash
> npm run build && npm link
> ```

Hi-Boss is a local daemon + `hiboss` CLI for routing "envelopes" between agents and chat channels (e.g., Telegram).

The daemon owns state (`~/.hiboss/`), exposes a local IPC API, and auto-runs agents when new envelopes arrive.

## Fast Path (Dev)

```bash
npm run build && npm link

hiboss setup
hiboss daemon start --debug
hiboss agent register --name nex --description "AI assistant" --workspace "$PWD"
```

## Naming Conventions

### Rules

| Context | Convention | Example |
|---------|------------|---------|
| Code (TypeScript) | camelCase | `envelope.fromBoss` |
| CLI flags | kebab-case, lowercase | `--deliver-at` |
| CLI output keys | kebab-case, lowercase | `from-boss:` |
| Agent instructions | kebab-case, lowercase | `from-boss` |

### Requirement for Uniformity

CLI flags, CLI output, and agent instructions **MUST** use the same naming format (kebab-case, lowercase) so agents can parse output and build commands without name translation.

### Canonical Examples

**Code → CLI:**
```
agent.name          →  --name         (flag)
agent.token         →  --token        (auth)
envelope.deliverAt  →  --deliver-at   (flag)
envelope.fromBoss   →  from-boss:     (output key)
envelope.createdAt  →  created-at:    (output key)
```

## Concepts

### Addresses

- agent: `agent:<agent-name>`
- channel: `channel:<adapter>:<chat-id>` (currently `telegram`)

### Tokens

- All envelope commands require `--token <agent-token>`.
- Tokens are printed once when you run `hiboss agent register` or `hiboss setup` — save them (there is no "show token" command).

### Permissions (Important)

- Sending to `channel:<adapter>:...` is only allowed if the sending agent is bound to that adapter type.

### Scheduled Delivery

Use `--deliver-at` to schedule envelopes for future delivery:

**Formats:**
- **Relative time:** `+2h`, `+30m`, `+1Y2M3D`, `-15m`
- **ISO 8601:** `2026-01-27T16:30:00+08:00`

**Units (case-sensitive):**
| Unit | Meaning |
|------|---------|
| `Y`  | Year    |
| `M`  | Month   |
| `D`  | Day     |
| `h`  | Hour    |
| `m`  | Minute  |
| `s`  | Second  |

**Examples:**
```bash
hiboss envelope send --to agent:nex --token <token> --text "reminder" --deliver-at +2h
hiboss envelope send --to agent:nex --token <token> --text "monthly" --deliver-at +1M
hiboss envelope send --to agent:nex --token <token> --text "complex" --deliver-at +2Y3M15D
```

**Notes:**
- Relative times are calculated from current local time, stored as UTC
- Month/year addition clamps to valid dates (Jan 31 + 1M → Feb 28/29)
- Segments apply left-to-right

## CLI Quick Reference (Accurate Examples)

```bash
# daemon
hiboss daemon status
hiboss daemon start --debug
hiboss daemon stop

# agents
hiboss agent register --name nex --description "AI assistant" --workspace "$PWD"
hiboss agent list
hiboss agent bind --name nex --adapter-type telegram --adapter-token <telegram-bot-token>
hiboss agent unbind --name nex --adapter-type telegram

# envelopes
hiboss envelope send --to agent:nex --token <agent-token> --text "hello" --deliver-at +2h
hiboss envelope list --token <agent-token> --box inbox --status pending --limit 10
hiboss envelope get --id <envelope-id> --token <agent-token>
```

## Agent Response Flow (Manual)

1. **Poll:** `hiboss envelope list --token <agent-token> --box inbox --status pending`
2. **Process:** parse the envelope (`from/text/attachments/...`)
3. **Send:** `hiboss envelope send --to <from> --token <agent-token> --text "response"`

Note: Envelopes are automatically acknowledged after the agent run completes.

## Setup

- Interactive (recommended): `hiboss setup`
- Default values: `hiboss setup default --boss-token <boss-token> [--boss-name <name>] [--adapter-type telegram --adapter-token <token> --adapter-boss-id <username>]`

Notes:
- Interactive setup lets you choose the default provider (`claude` or `codex`) for the initial agent it creates.
- `hiboss setup default` currently uses a fixed agent config (see `src/cli/commands/setup.ts`).

## Development Workflow

After editing any TypeScript code, rebuild and relink:

```bash
npm run build && npm link
```

## State, Logs, Debugging

- data dir: `~/.hiboss/`
- daemon log: `~/.hiboss/daemon.log`
- sqlite db: `~/.hiboss/hiboss.db`
- agent homes (provider configs + session state):
  - `~/.hiboss/agents/<agent-name>/codex_home/`
  - `~/.hiboss/agents/<agent-name>/claude_home/`

Inspect recent agent runs (table `agent_runs`):

```bash
sqlite3 ~/.hiboss/hiboss.db "select id, agent_name, status, datetime(started_at/1000,'unixepoch') as started_at from agent_runs order by started_at desc limit 20;"
```

## Reset / Refresh

- Full reset (wipes agents, bindings, DB): stop the daemon, delete `~/.hiboss`, then rerun `hiboss setup`.
- Refresh a session:
  - If using Telegram: send `/new` to the bot (handled by the daemon).
  - Otherwise: restart the daemon (`hiboss daemon stop` then `hiboss daemon start`).
