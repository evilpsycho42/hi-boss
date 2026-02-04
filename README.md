# Hi-Boss

Hi-Boss is a local daemon + `hiboss` CLI for routing messages (“envelopes”) between your agents and chat channels (e.g., Telegram), so autonomous assistants can work for you 24x7.

## Install

```bash
npm i -g hiboss
hiboss setup
# Save the printed boss-token and agent-token (they are only shown once)
hiboss daemon start --token <boss-token>
```

## Quickstart

```bash
# Send a message to an agent (use the agent token printed by setup/register)
hiboss envelope send --to agent:<agent-name> --token <agent-token> --text "hello"

# List pending messages from an address (ACKs what it returns)
hiboss envelope list --token <agent-token> --from <address> --status pending -n 10
```

## Memory

Hi-Boss provides two persistence mechanisms: **semantic memory** and **internal space**.

### Semantic memory (vector search)

Semantic memory is stored in LanceDB at:

- `~/.hiboss/memory.lance/`

Manage it via:

- `hiboss memory add/search/list/categories/get/delete/delete-category/clear`
- `hiboss memory setup --default` (download default embedding model)
- `hiboss memory setup --model-path <absolute-path-to-gguf>`

### Internal space (private files)

Each agent has a private working directory that is added to the agent’s workspace:

- `~/.hiboss/agents/<agent-name>/internal_space/`

Special file:
- `MEMORY.md` — auto-injected long-term memory file (truncated).

## Docs

- `docs/index.md` — docs hub (specs + user guides)
- `docs/guide/quickstart.md` — step-by-step getting started
- `docs/guide/telegram.md` — Telegram setup and usage
