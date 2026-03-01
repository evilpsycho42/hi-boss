# CLI: Teams

This document specifies `hiboss team ...`.

Teamspace layout:
- `{{HIBOSS_DIR}}/teamspaces/<team-name>/`

`teamspaces/` are shared working directories for team members. When an agent belongs to at least one active team, the primary active team's teamspace is used as the effective runtime workspace for provider sessions.

Because provider CLIs run from the effective workspace, team-level workspace config such as `.claude/` (and similar provider workspace files) can live inside the teamspace.

## `hiboss team register`

Creates a team and initializes its teamspace directory.

Flags:
- `--name <name>` (required; alphanumeric with hyphens)
- `--description <description>` (optional)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `success: true|false`
- `team-name:`
- `team-status:` (`active|archived`)
- `team-kind:` (`manual`)
- `description:` (`(none)` when unset)
- `created-at:` (boss timezone offset)
- `members:` (comma-separated agent names or `(none)`)

Default permission:
- `privileged`

## `hiboss team set`

Updates team metadata.

Flags:
- `--name <name>` (required)
- `--description <description>` (optional)
- `--clear-description` (optional; clears description)
- `--status <active|archived>` (optional)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `success: true|false`
- `team-name:`
- `team-status:`
- `team-kind:`
- `description:`
- `created-at:`
- `members:`

Default permission:
- `privileged`

## `hiboss team add-member`

Adds an agent to a team.

Flags:
- `--name <name>` (required)
- `--agent <agent-name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `success: true|false`
- `team-name:`
- `agent-name:`

Default permission:
- `privileged`

## `hiboss team remove-member`

Removes an agent from a team.

Flags:
- `--name <name>` (required)
- `--agent <agent-name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `success: true|false`
- `team-name:`
- `agent-name:`

Default permission:
- `privileged`

## `hiboss team status`

Shows one team and its member list.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `team-name:`
- `team-status:`
- `team-kind:`
- `description:`
- `created-at:`
- `members:`

Default permission:
- `restricted`

## `hiboss team list-members`

Lists member records for one team.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output:
- `team-name:`
- `member-count:`
- Empty result: `no-members: true`
- Non-empty: repeated blocks with:
  - `agent-name:`
  - `source:` (`manual`)
  - `joined-at:` (boss timezone offset)

Default permission:
- `restricted`

## `hiboss team send`

Sends one envelope to each member of a team (fan-out singlecast).

Status:
- Deprecated. Prefer `hiboss envelope send --to team:<name> ...`.

Flags:
- `--name <name>` (required)
- `--text <text>` (optional; use `-` to read from stdin)
- `--text-file <path>` (optional)
- `--attachment <path>` (optional; repeatable)
- `--deliver-at <time>` (optional)
- `--interrupt-now` (optional; mutually exclusive with `--deliver-at`)
- `--reply-to <envelope-id>` (optional)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output:
- `team-name:`
- `requested-count:`
- `sent-count:`
- `failed-count:`
- No recipients: `no-recipients: true`
- Per-recipient block:
  - `agent-name:`
  - `status:` (`sent|failed`)
  - `id:` (short envelope id or `none`)
  - `error:` (`none` when sent)

Notes:
- Sender is excluded from recipient set.
- Archived teams reject `team send`.
- Best-effort fan-out: one recipient failure does not abort remaining sends.
- CLI exits non-zero when `failed-count > 0`.

Default permission:
- `restricted`

## `hiboss team list`

Lists teams.

Flags:
- `--status <active|archived>` (optional filter)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output:
- Empty result: `no-teams: true`
- Non-empty: repeated blocks with:
  - `team-name:`
  - `team-status:`
  - `team-kind:`
  - `description:`
  - `created-at:`
  - `members:`

Default permission:
- `restricted`

## `hiboss team delete`

Deletes a team and removes its teamspace directory.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `success: true|false`
- `team-name:`

Default permission:
- `admin`
