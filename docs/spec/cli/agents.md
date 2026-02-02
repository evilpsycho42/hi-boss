# CLI: Agents

Auto-level:
- `medium` — workspace + additional dirs access (can write files and run a broad set of commands, but stays workspace-scoped)
- `high` — full access to this computer (can run almost anything; recommended only when you trust the agent)
- Note: unified-agent-sdk supports `low`, but Hi-Boss disallows it because it can block `hiboss` CLI usage.

## `hiboss agent register`

Registers a new agent.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)
- `--description <description>` (optional)
- `--workspace <path>` (optional)
- `--provider <claude|codex>` (optional)
- `--provider-source-home <path>` (optional; when used with `--provider`, imports provider config from this directory)
- `--model <model>` (optional)
- `--reasoning-effort <none|low|medium|high|xhigh>` (optional)
- `--auto-level <medium|high>` (optional)
- `--permission-level <restricted|standard|privileged>` (optional)
- `--metadata-json <json>` or `--metadata-file <path>` (optional)
- Optional binding at creation:
  - `--bind-adapter-type <type>`
  - `--bind-adapter-token <token>`
- Optional session policy inputs:
  - `--session-daily-reset-at HH:MM`
  - `--session-idle-timeout <duration>` (units: `d/h/m/s`)
  - `--session-max-context-length <n>`

Provider config import:
- When `--provider` is provided, Hi-Boss imports provider config files into the agent’s provider home.
- If `--provider-source-home` is omitted, Hi-Boss uses the provider default source home:
  - `codex` → `~/.codex/`
  - `claude` → `~/.claude/`

Output (parseable):
- `name:`
- `description:` (optional)
- `workspace:` (optional)
- `token:` (printed once)

## `hiboss agent set`

Updates agent settings and (optionally) binds/unbinds adapters.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)
- `--description <description>` (optional)
- `--workspace <path>` (optional)
- `--provider <claude|codex>` (optional)
- `--provider-source-home <path>` (optional; when used with `--provider`, imports provider config from this directory)
- `--model <model>` (optional; use `default` to clear and use provider default)
- `--reasoning-effort <default|none|low|medium|high|xhigh>` (optional)
- `--auto-level <medium|high>` (optional)
- `--permission-level <restricted|standard|privileged>` (optional; boss token only)
- Session policy:
  - `--session-daily-reset-at HH:MM` (optional)
  - `--session-idle-timeout <duration>` (optional; units: `d/h/m/s`)
  - `--session-max-context-length <n>` (optional)
  - `--clear-session-policy` (optional)
- Metadata:
  - `--metadata-json <json>` or `--metadata-file <path>` (optional)
  - `--clear-metadata` (optional)
- Binding:
  - `--bind-adapter-type <type>` + `--bind-adapter-token <token>` (optional)
  - `--unbind-adapter-type <type>` (optional)

Provider config import:
- When `--provider` is provided, Hi-Boss imports provider config files into the agent’s provider home.
- If `--provider-source-home` is omitted, Hi-Boss uses the provider default source home:
  - `codex` → `~/.codex/`
  - `claude` → `~/.claude/`

Output (parseable):
- `success: true|false`
- `agent-name:`
- Updated fields when present (e.g., `provider:`, `model:`, `reasoning-effort:`, `auto-level:`, `permission-level:`)
- `bindings:` (optional; comma-separated adapter types)

## `hiboss agent list`

Lists all agents.

Empty output:

```
no-agents: true
```

Output (parseable, one block per agent):
- `name:`
- `description:` (optional)
- `workspace:` (optional)
- `provider:` / `model:` / `reasoning-effort:` / `auto-level:` (optional)
- `permission-level:` (optional)
- `session-daily-reset-at:` / `session-idle-timeout:` / `session-max-context-length:` (optional)
- `bindings:` (optional; comma-separated adapter types)
- `created-at:` (local timezone offset)
- `last-seen-at:` (optional; local timezone offset)

Default permission:
- `restricted`
