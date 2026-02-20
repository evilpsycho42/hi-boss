# Hi-Boss

[中文说明](README.zh-CN.md)

Orchestrate Codex / Claude Code agents from Telegram — with durable communication, editable memory, and non-blocking parallel execution.

Highlights:
- Provider flexibility: supports both official provider workflows and relay fallback paths (官方直连 + 中转站方案).
- Built-in memory system: human-readable, directly editable Markdown memory for each agent.
- Envelope system: durable agent↔agent and agent↔user communication with auditable message flow.
- Non-blocking delegation: background/leader agents handle heavy tasks in parallel, while specialist agents can be registered for focused domains.

## Sponsor

[![YesCode logo](docs/assets/sponsors/yescode-logo.png)](https://co.yes.vg)

YesCode is a reliable Claude Code/Codex relay provider with stable service quality and reasonable pricing.

## Install

Before setup, make sure at least one provider CLI is installed and runnable:
- **Claude Code** (`claude --version`)
- **Codex** (`codex exec --help`)

Via npm:

```bash
npm i -g hiboss
hiboss setup
hiboss daemon start --token <boss-token>
```

First run (setup + start daemon):

```bash
hiboss setup
hiboss daemon start --token <boss-token>
```

Upgrade:

```bash
hiboss daemon stop --token <boss-token>
npm i -g hiboss@latest
```

Tip: restart the daemon after upgrading:

```bash
hiboss daemon start --token <boss-token>
```

Dev/from source: see `docs/index.md`.

## Setup

`hiboss setup` initializes local state and prints tokens once.

| Item | Path |
|---|---|
| Data root (default) | `~/hiboss/` |
| Data root (override) | `$HIBOSS_DIR` |
| Daemon internals (db/socket/log/pid) | `${HIBOSS_DIR:-$HOME/hiboss}/.daemon/` |
| Agent memory file | `${HIBOSS_DIR:-$HOME/hiboss}/agents/<agent-name>/internal_space/MEMORY.md` |
| Daily memory files | `${HIBOSS_DIR:-$HOME/hiboss}/agents/<agent-name>/internal_space/memories/` |

Directory sketch:

```text
${HIBOSS_DIR:-$HOME/hiboss}/
  .daemon/
  agents/<agent-name>/internal_space/
    MEMORY.md
    memories/
```

Repair / reset:
- Healthy setup rerun (safe no-op): `hiboss setup`
- Broken/incomplete setup (non-destructive) via `settings.json` edit:

```bash
hiboss daemon stop --token <boss-token>
# edit ${HIBOSS_DIR:-$HOME/hiboss}/settings.json
hiboss daemon start --token <boss-token>
```

- Canonical repair template for single-agent Telegram setups (speaker only, missing leader). Save this as `./hiboss.repair.v3.json`, fill placeholders, and copy to `${HIBOSS_DIR:-$HOME/hiboss}/settings.json`:

```json
{
  "version": 3,
  "boss": {
    "name": "<your-name>",
    "timezone": "<IANA-timezone>",
    "token": "<boss-token>"
  },
  "telegram": {
    "boss-ids": ["<telegram-username-without-@>"]
  },
  "permission-policy": {
    "version": 1,
    "operations": {
      "envelope.send": "restricted",
      "agent.register": "boss"
    }
  },
  "agents": [
    {
      "name": "nex",
      "token": "<speaker-agent-token>",
      "role": "speaker",
      "provider": "<claude-or-codex>",
      "description": "Telegram speaker agent",
      "workspace": "<absolute-workspace-path>",
      "model": null,
      "reasoning-effort": null,
      "permission-level": "standard",
      "bindings": [
        {
          "adapter-type": "telegram",
          "adapter-token": "<telegram-bot-token>"
        }
      ]
    },
    {
      "name": "kai",
      "token": "<leader-agent-token>",
      "role": "leader",
      "provider": "<claude-or-codex>",
      "description": "Background leader agent",
      "workspace": "<absolute-workspace-path>",
      "model": null,
      "reasoning-effort": null,
      "permission-level": "standard",
      "bindings": []
    }
  ]
}
```

```bash
hiboss daemon stop --token <boss-token>
cp ./hiboss.repair.v3.json "${HIBOSS_DIR:-$HOME/hiboss}/settings.json"
hiboss daemon start --token <boss-token>
```

Full reset (destructive):

```bash
hiboss daemon stop --token <boss-token>
rm -rf "${HIBOSS_DIR:-$HOME/hiboss}"
hiboss setup
hiboss daemon start --token <boss-token>
```

Tip: most commands accept `--token <token>` or read `HIBOSS_TOKEN` when `--token` is omitted.

## Telegram

Hi-Boss connects an agent to Telegram via a bot.

1) Create a Telegram bot token via @BotFather.

2) Bind the bot to a `speaker` agent (the setup-created speaker is bound during `hiboss setup`; use this for additional speaker agents):

```bash
hiboss agent set --token <boss-token> --name <speaker-agent-name> --role speaker --bind-adapter-type telegram --bind-adapter-token <telegram-bot-token>
```

3) Talk to your agent by messaging the bot in Telegram.

Boss-only Telegram commands:
- `/status` — show `hiboss agent status` for the bound agent
- `/new` — request a session refresh for the bound agent
- `/abort` — cancel current run and clear the bound agent's due pending inbox

## Agent

Manage agents via the CLI (create / update / remove), and optionally delegate admin to a trusted agent via `permission-level`.

Create/register a new agent:

```bash
hiboss agent register --token <boss-token> --name ops-bot --role leader --provider codex --description "AI assistant" --workspace "$PWD"
```

Update an agent (manual configuration):

```bash
hiboss agent set --token <boss-token> --name ops-bot --provider codex --permission-level privileged
```

Remove an agent:

```bash
hiboss agent delete --token <boss-token> --name ops-bot
```

List / status:

```bash
hiboss agent list --token <boss-token>
hiboss agent status --token <boss-token> --name ops-bot
```

### Permission levels

Hi-Boss separates:
- **Boss-marked messages** (`fromBoss` / `[boss]` in prompts) — adapter identity (e.g., your Telegram username), and
- **Authorization** (`permission-level`) — what a token is allowed to do via CLI/RPC.

Available levels: `restricted`, `standard`, `privileged`, `boss`.

Set permission level:

```bash
hiboss agent set --token <boss-token> --name <agent-name> --permission-level <level>
```

### Boss-level agent (delegate admin)

If you want an agent to be able to do Hi-Boss admin operations just by chatting with it (register agents, remove agents, rebind adapters, etc.), grant it `permission-level: boss`:

```bash
hiboss agent set --token <boss-token> --name <agent-name> --permission-level boss
```

Then, as the boss/user, go to Telegram and ask that agent to perform admin tasks for you (e.g., “add an agent”, “remove an agent”, “update bindings”). If you prefer, you can always do the same operations manually with `hiboss agent register|set|delete`.

This is powerful: a boss-level agent token can perform any boss-privileged CLI operations. Only do this for an agent you fully trust.

## Memory

Per-agent memory lives under `${HIBOSS_DIR:-$HOME/hiboss}/agents/<agent-name>/internal_space/`:
- `MEMORY.md` — long-term memory
- `memories/YYYY-MM-DD.md` — daily memory files

## Docs

- `docs/index.md` — docs hub (specifications)
- `docs/spec/index.md` — spec entrypoint + map
- `docs/spec/cli.md` — CLI command surface and links
- `docs/spec/adapters/telegram.md` — Telegram adapter behavior
