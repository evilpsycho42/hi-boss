# CLI: Projects

This document specifies `hiboss project ...`.

Projects are persistent project-scoped views stored in SQLite (`projects`, `project_leaders`).
They are maintained from orchestration context (for example `envelope.send` work-item flow).

## `hiboss project list`

Lists projects.

Flags:
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)
- `-n, --limit <n>` (optional; default `50`, max `200`)

Output (parseable, one block per project):
- `project-id:`
- `project-name:`
- `project-root:`
- `project-speaker-agent:`
- `project-main-group-channel:` (`(none)` when empty)
- `project-leaders:` (comma-separated agent names or `(none)`)
- `created-at:` (boss timezone offset)
- `updated-at:` (boss timezone offset or `(none)`)

Empty output:

```text
no-projects: true
```

Default permission:
- `restricted`

## `hiboss project get`

Gets one project by id.

Flags:
- `--id <id>` (required; lowercase letters/numbers with optional `. _ : -`)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `project-id:`
- `project-name:`
- `project-root:`
- `project-speaker-agent:`
- `project-main-group-channel:`
- `project-leaders:`
- `created-at:`
- `updated-at:`

Default permission:
- `restricted`

## `hiboss project select-leader`

Selects the best leader candidate for a project.

Flags:
- `--project-id <id>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)
- `--require-capability <capability>` (optional, repeatable)

Selection policy:
- Candidate set starts from `project_leaders` where `active=1`.
- Candidates are dropped when the agent workspace does not match `project.root`.
- Candidates are filtered by required capabilities (all required capabilities must exist).
- Remaining candidates are sorted by:
  1) health (`ok` > `unknown` > `error`),
  2) busy state (not busy first),
  3) agent name (ascending).

Output (parseable):
- `project-id:`
- `required-capabilities:` (comma-separated or `(none)`)
- `candidate-count:`
- `selected-agent:` (or `(none)`)
- `selected-agent-health:` (`ok|unknown|error` or `(none)`)
- `selected-agent-busy:` (`true|false` or `(none)`)
- `selected-capabilities:` (comma-separated or `(none)`)
- `candidate-<n>:` (`agent=<name>; health=<health>; busy=<true|false>; capabilities=<csv-or-(none)>`)

Default permission:
- `restricted`
