# CLI: Agents

Note: Hi-Boss currently runs provider CLIs in **full-access mode** (bypassing sandboxing / permission prompts) so agents can reliably execute `hiboss` commands.

## `hiboss agent register`

Registers a new agent.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)
- `--role <speaker|leader>` (required)
- `--description <description>` (optional)
- `--workspace <path>` (optional)
- `--provider <claude|codex>` (required)
- `--model <model>` (optional)
- `--reasoning-effort <default|none|low|medium|high|xhigh>` (optional; use `default` to clear and use provider default)
- `--permission-level <restricted|standard|privileged|boss>` (optional; `boss` requires boss-privileged token)
- `--metadata-json <json>` or `--metadata-file <path>` (optional)
- Optional binding at creation:
  - `--bind-adapter-type <type>`
  - `--bind-adapter-token <token>`
- Optional session policy inputs:
  - `--session-daily-reset-at HH:MM`
  - `--session-idle-timeout <duration>` (units: `d/h/m/s`)
  - `--session-max-context-length <n>`
- `--dry-run` (optional; validate only, no mutation)

Behavior when flags are omitted:
Required flags (validation error):
- `provider`
- `role`

Optional flags (defaults):
- `model`: provider default (`NULL` override)
- `reasoning-effort`: provider default (`NULL` override)
- `permission-level`: `standard`
- `description`: generated default description
- `workspace`: unset (`NULL`)
- `session-policy`: unset
- `metadata`: unset

Notes:
- `--role speaker` requires binding at registration (`--bind-adapter-type` + `--bind-adapter-token`).
- `--model default` on register clears the model override to provider default (`NULL`).
- `--reasoning-effort default` on register clears the reasoning-effort override to provider default (`NULL`).

Provider-home behavior follows `docs/spec/cli/conventions.md#provider-homes`.

Output (parseable):
- `name:`
- `role:`
- `description:` (always; generated default when omitted; may be empty string)
- `workspace:` (`(none)` when unset)
- `token:` (printed once)
- `dry-run: true` (only when `--dry-run` is set)

Note:
- In `agent register` output, `workspace: (none)` means no explicit override is stored. Effective runtime workspace falls back to the user's home directory.
- In dry-run mode, `token:` is rendered as `(dry-run)` and no agent/token is persisted.

## `hiboss agent set`

Updates agent settings and (optionally) binds/unbinds adapters.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)
- `--role <speaker|leader>` (optional; explicit role assignment)
- `--description <description>` (optional)
- `--workspace <path>` (optional)
- `--provider <claude|codex>` (optional)
- `--model <model>` (optional; use `default` to clear and use provider default)
- `--reasoning-effort <default|none|low|medium|high|xhigh>` (optional)
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
- Role/binding mutations are rejected when they would violate the required role invariant (`>=1 speaker` and `>=1 leader`).
- Speakers must keep at least one binding.
- `--role speaker` requires at least one resulting binding in the same command.
- `--bind-adapter-*` and `--unbind-adapter-type` may be used together for same-command binding swaps.
- `--bind-adapter-*` alone replaces an existing binding token for that same adapter type on the target agent (atomic replace).

Provider-home behavior follows `docs/spec/cli/conventions.md#provider-homes`.

Output (parseable):
- `success: true|false`
- `agent-name:`
- `role:`
- `description:` (`(none)` when unset)
- `workspace:` (`(none)` when unset)
- `provider:` (`(none)` when unset)
- `model:` (`default` when unset)
- `reasoning-effort:` (`default` when unset)
- `permission-level:`
- `bindings:` (`(none)` when no bindings; otherwise comma-separated adapter types)
- `session-daily-reset-at:` (optional)
- `session-idle-timeout:` (optional)
- `session-max-context-length:` (optional)

## `hiboss agent delete`

Deletes an agent.

This removes the agent record, its bindings, its cron schedules, and its home directory under `~/hiboss/agents/<agent-name>/` (or `{{HIBOSS_DIR}}/agents/<agent-name>/` when overridden). It does **not** delete historical envelopes or agent runs (audit log).

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`; boss-privileged token required)

Output (parseable):
- `success: true|false`
- `agent-name:`

## `hiboss agent list`

Lists all agents.

Example:

```bash
hiboss agent list
```

```text
name: nex
role: speaker
workspace: /path/to/workspace
created-at: 2026-02-03T14:22:10-08:00

name: ops-bot
role: leader
created-at: 2026-02-01T09:05:44-08:00
```

Empty output:

```
no-agents: true
```

Output (parseable, one block per agent):
- `name:`
- `role:` (`speaker|leader`)
- `workspace:` (optional)
- `created-at:` (boss timezone offset)

Default permission:
- `restricted`

---

## `hiboss agent status`

Shows runtime status for a single agent (intended for operator UX and dashboards).

Notes:
- Requires a token (agent or boss). The output must not include secrets (agent token, adapter token).
- When called with an agent token, only `--name <self>` is allowed (agents cannot query other agents).
- `workspace:` in status is the effective runtime workspace. If unset on the agent record, it falls back to the user's home directory.
- `agent-state` is a **busy-ness** signal: `running` means the daemon currently has a queued or in-flight task for this agent (so replies may be delayed).
- `role:` is shown when available (`speaker` or `leader`).
- `agent-health` is derived from the most recent finished run: `ok` (last run completed or cancelled), `error` (last run failed), `unknown` (no finished runs yet).
- `pending-count` counts **due** pending envelopes (`status=pending` and `deliver_at` is missing or `<= now`).

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Example (with session policy and bindings):

```bash
hiboss agent status --name nex
```

```text
name: nex
workspace: /path/to/workspace
provider: codex
model: default
reasoning-effort: default
permission-level: restricted
bindings: telegram
session-daily-reset-at: 03:00
session-idle-timeout: 30m
session-max-context-length: 180000
agent-state: idle
agent-health: ok
pending-count: 0
last-run-id: 2b7b6f0b
last-run-status: completed
last-run-started-at: 2026-02-03T12:00:00-08:00
last-run-completed-at: 2026-02-03T12:01:03-08:00
last-run-context-length: 4123
```

Output (parseable):
- `name:`
- `workspace:`
- `provider:` (`(none)` when unset)
- `model:` (`default` when unset)
- `reasoning-effort:` (`default` when unset)
- `permission-level:`
- `bindings:` (optional; comma-separated adapter types)
- `session-daily-reset-at:` (optional)
- `session-idle-timeout:` (optional)
- `session-max-context-length:` (optional)
- `agent-state:` (`running|idle`)
- `agent-health:` (`ok|error|unknown`)
- `pending-count: <n>`
- `current-run-id:` (optional; short id; when `agent-state=running` and a run record exists)
- `current-run-started-at:` (optional; boss timezone offset)
- `last-run-id:` (optional; short id)
- `last-run-status:` (`completed|failed|cancelled|none`)
- `last-run-started-at:` (optional; boss timezone offset)
- `last-run-completed-at:` (optional; boss timezone offset)
- `last-run-context-length:` (optional; integer, when available)
  - Meaning: best-effort **final model-call size** for the last successful run (prompt + output); see `docs/spec/provider-clis.md#token-usage`.
- `last-run-error:` (optional; only when `last-run-status=failed|cancelled`)

---

## `hiboss agent abort`

Cancels the current in-flight run for an agent (best-effort) and clears the agent’s **due** pending inbox.

Notes:
- Intended for operator “stop what you’re doing” moments.
- Cron-generated and future scheduled envelopes are not cancelled.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`; boss token required)

Output (parseable):
- `success: true|false`
- `agent-name:`
- `cancelled-run: true|false`
- `cleared-pending-count: <n>`
