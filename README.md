# Hi-Boss

在 Telegram 上指挥基于 Codex / Claude Code 的 agents——它们不止会帮你做事，也会彼此协作。

Highlights:
- 基于底层 provider（Codex / Claude Code）执行 → 追求最好可用的真实执行效果
- agent↔human、agent↔agent 的“收发件箱”式通信（Telegram 等 adapters ↔ 本地 daemon ↔ agents）
- 支持延时投递与 cron 调度任务（durable、可追溯）

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

Upgrade tip: stop the daemon before upgrading:

```bash
hiboss daemon stop --token <boss-token>
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

Stop the daemon:

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

## Agents (create / set / remove)

Create/register a new agent:

```bash
hiboss agent register --token <boss-token> --name nex --description "AI assistant" --workspace "$PWD"
```

Update an agent:

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

## Boss permission level (let an agent administer Hi-Boss)

Hi-Boss separates:
- **Boss-marked messages** (`fromBoss` / `[boss]` in prompts) — this is adapter identity (e.g., your Telegram username), and
- **Authorization** (`permission-level`) — what a token is allowed to do via CLI/RPC.

If you want an agent to be able to do all Hi-Boss admin operations just by chatting with it (register agents, rebind adapters, etc.), you can grant it `permission-level: boss`:

```bash
hiboss agent set --token <boss-token> --name <agent-name> --permission-level boss
```

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
