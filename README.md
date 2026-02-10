# Hi-Boss

Orchestrate Codex / Claude Code agents from Telegram — they don’t just work for you; they can collaborate with each other.

Highlights:
- Run on top of real providers (Codex / Claude Code) for best-in-class execution quality
- Durable “inbox/outbox” communication: agent↔human and agent↔agent (Telegram adapters ↔ local daemon ↔ agents)
- Scheduled delivery and cron jobs (durable, auditable)

## Providers: Claude Code + Codex

Hi-Boss runs agent turns by spawning provider CLIs directly:

- **Claude Code CLI**: `claude`
- **Codex CLI**: `codex exec`

Provider state/config lives in the user's shared homes:
- Claude: `~/.claude`
- Codex: `~/.codex`

Hi-Boss does **not** copy provider config files into `~/hiboss`. System instructions are injected inline via CLI flags:
- Claude: `--append-system-prompt`
- Codex: `-c developer_instructions=...`

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
- `/abort` — cancel current run and clear the bound agent's due pending inbox

## Agent

Manage agents via the CLI (create / update / remove), and optionally delegate admin to a trusted agent via `permission-level`.

Create/register a new agent:

```bash
hiboss agent register --token <boss-token> --name nex --provider codex --description "AI assistant" --workspace "$PWD"
```

Update an agent (manual configuration):

```bash
hiboss agent set --token <boss-token> --name nex --provider codex --permission-level privileged
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

## Docs

- `docs/index.md` — docs hub (specs + user guides)
- `docs/guide/install.md` — install + upgrade notes
- `docs/guide/telegram.md` — Telegram setup and usage
- `docs/guide/overview.md` — features overview (cron, deliver-at, etc.)
- `docs/guide/recipes.md` — cron/scheduling recipes
