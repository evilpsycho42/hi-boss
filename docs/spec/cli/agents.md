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
- `--reasoning-effort <default|none|low|medium|high|xhigh>` (optional; use `default` to clear and use provider default)
- `--auto-level <medium|high>` (optional)
- `--permission-level <restricted|standard|privileged|boss>` (optional; `boss` requires boss-privileged token)
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
- `--permission-level <restricted|standard|privileged|boss>` (optional; boss-privileged token only)
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

Notes:
- Updating `--provider`, `--model`, or `--reasoning-effort` does **not** force a session refresh. Existing/resumed sessions may continue using the previous session config until a refresh (`/new`) or policy refresh opens a new session.
- When switching providers without specifying `--model` / `--reasoning-effort`, Hi-Boss clears these overrides so the new provider can use its defaults when a fresh session is eventually opened.
- `--clear-metadata` clears user metadata but preserves the internal session resume handle (`metadata.sessionHandle`). The `sessionHandle` key is reserved and is ignored if provided via `--metadata-*`.

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

## `hiboss agent delete`

Deletes an agent.

This removes the agent record, its bindings, its cron schedules, and its home directory under `~/.hiboss/agents/<agent-name>/`. It does **not** delete historical envelopes or agent runs (audit log).

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`; boss-privileged token required)

Output (parseable):
- `success: true|false`
- `agent-name:`

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
- `model:` (optional)
- `reasoning-effort:` (optional)
- `session-daily-reset-at:` / `session-idle-timeout:` / `session-max-context-length:` (optional)
- `created-at:` (local timezone offset)

Default permission:
- `restricted`

---

## `hiboss agent status`

Shows runtime status for a single agent (intended for operator UX and dashboards).

Notes:
- Requires a token (agent or boss). The output must not include secrets (agent token, adapter token).
- When called with an agent token, only `--name <self>` is allowed (agents cannot query other agents).
- `agent-state` is a **busy-ness** signal: `running` means the daemon currently has a queued or in-flight task for this agent (so replies may be delayed).
- `agent-health` is derived from the most recent finished run: `ok` (last run completed), `error` (last run failed), `unknown` (no finished runs yet).
- `pending-count` counts **due** pending envelopes (`status=pending` and `deliver_at` is missing or `<= now`).

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `name:`
- `workspace:`
- `provider:`
- `model:` (`default` when unset)
- `reasoning-effort:` (`default` when unset)
- `auto-level:`
- `permission-level:`
- `bindings:` (optional; comma-separated adapter types)
- `agent-state:` (`running|idle`)
- `agent-health:` (`ok|error|unknown`)
- `pending-count: <n>`
- `current-run-id:` (optional; when `agent-state=running` and a run record exists)
- `current-run-started-at:` (optional; local timezone offset)
- `last-run-id:` (optional)
- `last-run-status:` (`completed|failed|none`)
- `last-run-started-at:` (optional; local timezone offset)
- `last-run-completed-at:` (optional; local timezone offset)
- `last-run-context-length:` (optional; integer, when available)
- `last-run-error:` (optional; only when `last-run-status=failed`)
