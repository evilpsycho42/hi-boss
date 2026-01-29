# Hi-Boss

Hi-Boss is a local daemon + `hiboss` CLI for routing messages (“envelopes”) between your agents and chat channels (e.g., Telegram), so autonomous assistants can work for you 24x7.

## Install

```bash
npm i -g hiboss
hiboss setup
hiboss daemon start
```

## Quickstart

```bash
# Send a message to an agent (use the agent token printed by setup/register)
hiboss envelope send --to agent:<agent-name> --token <agent-token> --text "hello"

# List pending inbox messages for an agent
hiboss envelope list --token <agent-token> --box inbox --status pending -n 10
```

## Memory

Hi-Boss bundles `mem-cli` and exposes it as `hiboss mem ...` for per-agent private memory (keyed by the agent token).
Private workspaces are stored under `~/.hiboss/agents/<agent-name>/.mem-cli/` by default.

```bash
# Use the agent token for private memory
export HIBOSS_TOKEN=<agent-token>

# Daily scratchpad (appends to memory/YYYY-MM-DD.md)
hiboss mem add short "..."

# Long-term memory (appends to MEMORY.md)
echo "..." | hiboss mem add long --stdin

# Retrieve
hiboss mem search "query"

# Shared memory (public)
hiboss mem add short "..." --public
```

## Docs

- `docs/index.md` — docs hub (specs + user guides)
- `docs/guide/quickstart.md` — step-by-step getting started
- `docs/guide/telegram.md` — Telegram setup and usage
