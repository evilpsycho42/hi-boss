# Hi-Boss

Orchestrate Codex / Claude Code agents from Telegram — they don’t just work for you; they can collaborate with each other.

Highlights:
- Run on top of real providers (Codex / Claude Code) for best-in-class execution quality
- Durable “inbox/outbox” communication: agent↔human and agent↔agent (Telegram adapters ↔ local daemon ↔ agents)
- Scheduled delivery and cron jobs (durable, auditable)

## Providers: Claude Code + Codex

Hi-Boss runs agent turns through the Unified Agent SDK runtime with either provider:

- **Claude Code** (`--provider claude`)
- **Codex** (`--provider codex`)

When you run `hiboss setup` / `hiboss agent register`, Hi-Boss imports your provider auth/settings from `~/.claude/` or `~/.codex/`.

You can also override the import source home:
- Setup: via the interactive wizard, or `hiboss setup --config-file <path>`
- Agents: `hiboss agent register|set --provider-source-home <path>`

## Install

Via npm:

```bash
npm i -g hiboss
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

1) Run the interactive setup wizard:

```bash
hiboss setup
```

Setup:
- initializes local state (SQLite + per-agent homes)
- prompts for your boss name and timezone
- creates your first agent
- configures a Telegram bot + boss Telegram username for that first agent
- prints `boss-token:` and `agent-token:` **once** (save them somewhere safe)

State directory:
- default: `~/hiboss/`
- internal daemon files: `~/hiboss/.daemon/` (db/socket/log/pid)
- override the root with `HIBOSS_DIR`

2) Start the daemon:

```bash
hiboss daemon start --token <boss-token>
```

Next: open Telegram and talk with your agent by messaging the bot (see the Telegram section below).

To stop the Hi-Boss service:

```bash
hiboss daemon stop --token <boss-token>
```

Tip: most commands accept `--token <token>` or read `HIBOSS_TOKEN` when `--token` is omitted.

## Telegram

Hi-Boss connects an agent to Telegram via a bot.

1) Create a Telegram bot token via @BotFather.

2) Bind the bot to an agent (the first agent is bound during `hiboss setup`; use this for additional agents):

```bash
hiboss agent set --token <boss-token> --name <agent-name> --bind-adapter-type telegram --bind-adapter-token <telegram-bot-token>
```

3) Talk to your agent by messaging the bot in Telegram.

Boss-only Telegram commands:
- `/status` — show `hiboss agent status` for the bound agent
- `/new` — request a session refresh for the bound agent

## Agent

Manage agents via the CLI (create / update / remove), and optionally delegate admin to a trusted agent via `permission-level`.

Create/register a new agent:

```bash
hiboss agent register --token <boss-token> --name nex --description "AI assistant" --workspace "$PWD"
```

Update an agent (manual configuration):

```bash
hiboss agent set --token <boss-token> --name nex --provider codex --auto-level medium --permission-level privileged
```

Remove an agent:

```bash
hiboss agent delete --token <boss-token> --name nex
```

List / status:

```bash
hiboss agent list --token <boss-token>
hiboss agent status --token <boss-token> --name nex
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

Each agent has a long-term memory file at:

- `~/hiboss/agents/<agent-name>/internal_space/MEMORY.md` (or `{{HIBOSS_DIR}}/agents/<agent-name>/internal_space/MEMORY.md` when overridden)

## Skills

Hi-Boss supports a simple three-layer skill system:

1) **Agent-local skills** (highest precedence): `{{HIBOSS_DIR}}/agents/<agent-name>/<provider>_home/skills/<skill-name>/`
2) **Global skills** (shared by all agents): `{{HIBOSS_DIR}}/skills/<skill-name>/`
3) **Built-in skills** (shipped with Hi-Boss; managed automatically)

Agent-local skills are just the provider’s normal `skills/` directory (Claude Code / Codex) — no special Hi-Boss format.
You can add them manually, or ask the agent to add/update skills in its own provider home.

To add a skill, create a skill folder containing a `SKILL.md` file in either the global or agent-local location.

Name conflicts: `agent-local > global > built-in`. Prefer unique skill names to avoid surprises.

Built-in skills:
- `agent-browser` — web browsing / page extraction workflow (source: vercel-labs/agent-browser)

## Docs

- `docs/index.md` — docs hub (specs + user guides)
- `docs/guide/install.md` — install + upgrade notes
- `docs/guide/telegram.md` — Telegram setup and usage
- `docs/guide/overview.md` — features overview (cron, deliver-at, etc.)
- `docs/guide/recipes.md` — cron/scheduling recipes
