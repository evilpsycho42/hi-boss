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
