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

## Docs

- `docs/index.md` — docs hub (specs + user guides)
- `docs/guide/quickstart.md` — step-by-step getting started
- `docs/guide/telegram.md` — Telegram setup and usage
