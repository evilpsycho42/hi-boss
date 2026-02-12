# Hi-Boss Configuration

This document is the configuration entrypoint: where configuration comes from, and where it is persisted.

## Sources

Hi-Boss configuration comes from:

1. CLI flags (`hiboss ... --flag`)
2. Environment variables (`HIBOSS_TOKEN`, `HIBOSS_DIR`, …)
3. SQLite state (`{{HIBOSS_DIR}}/.daemon/hiboss.db`)

## Defaults

Built-in defaults are centralized in:
- `src/shared/defaults.ts`

## Canonical topics

- Data directory layout: `docs/spec/config/data-dir.md`
- Environment variables: `docs/spec/config/env.md`
- SQLite state (tables + invariants): `docs/spec/config/sqlite.md`

## CLI surfaces (configuration changes)

- Setup: `docs/spec/cli/setup.md`
- Daemon: `docs/spec/cli/daemon.md`
- Agents: `docs/spec/cli/agents.md`
- Envelopes: `docs/spec/cli/envelopes.md`
- Cron: `docs/spec/cli/cron.md`
- Reactions: `docs/spec/cli/reactions.md`
- Memory: `docs/spec/cli/memory.md`

---

## “Settings” That Are Not Yet Exposed

Some settings exist in the database/schema but do not yet have dedicated CLI setters:

- Updating `boss_name`, `adapter_boss_id_<type>` after setup
- Editing `config.permission_policy`
- Changing the default data directory from `~/hiboss/` (override via `HIBOSS_DIR`)

Today, changing those requires a reset + re-setup, or direct DB edits.

---

## Permission Policy

Hi-Boss authorizes operations via a configurable policy stored at:

- `config.permission_policy`

The policy maps an operation name to a minimum permission level:

- `restricted < standard < privileged < boss`

If an operation is missing from the policy, it defaults to `boss` (safe-by-default).

### Default Policy

| Operation | Default Level |
|-----------|---------------|
| `envelope.send` | `restricted` |
| `envelope.list` | `restricted` |
| `daemon.status` | `boss` |
| `daemon.ping` | `standard` |
| `daemon.start` | `boss` |
| `daemon.stop` | `boss` |
| `agent.register` | `boss` |
| `agent.list` | `restricted` |
| `agent.bind` | `privileged` |
| `agent.unbind` | `privileged` |
| `agent.status` | `restricted` |
| `agent.refresh` | `boss` |
| `agent.abort` | `boss` |
| `agent.set` | `privileged` |
| `agent.session-policy.set` | `privileged` |
