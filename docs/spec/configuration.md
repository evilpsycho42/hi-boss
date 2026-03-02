# Hi-Boss Configuration

This document is the configuration entrypoint: where configuration comes from, and where it is persisted.

## Sources

Hi-Boss configuration comes from:

1. CLI flags (`hiboss ... --flag`)
2. Environment variables (`HIBOSS_TOKEN`, `HIBOSS_DIR`, …)
3. `settings.json` (`{{HIBOSS_DIR}}/settings.json`, source-of-truth)
4. SQLite runtime cache (`{{HIBOSS_DIR}}/.daemon/hiboss.db`)

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
- Teams: `docs/spec/cli/teams.md`
- Envelopes: `docs/spec/cli/envelopes.md`
- Cron: `docs/spec/cli/cron.md`
- Reactions: `docs/spec/cli/reactions.md`

---

## Settings Source of Truth

`settings.json` is the canonical configuration. Operators can edit it directly and restart daemon.

SQLite remains a runtime cache for read-path performance and relational references.

---

## Permission Policy

Hi-Boss authorizes operations via a configurable policy stored at:

- `settings.json.permission-policy` (source-of-truth)
- mirrored to `config.permission_policy` in SQLite runtime cache

The policy maps an operation name to a minimum permission level:

- `restricted < standard < privileged < admin`

If an operation is missing from the policy, it defaults to `admin` (safe-by-default).

### Default Policy

| Operation | Default Level |
|-----------|---------------|
| `envelope.send` | `restricted` |
| `envelope.list` | `restricted` |
| `envelope.thread` | `restricted` |
| `session.list` | `restricted` |
| `reaction.set` | `restricted` |
| `cron.create` | `restricted` |
| `cron.list` | `restricted` |
| `cron.enable` | `restricted` |
| `cron.disable` | `restricted` |
| `cron.delete` | `restricted` |
| `daemon.status` | `admin` |
| `daemon.ping` | `standard` |
| `daemon.time` | `restricted` |
| `daemon.start` | `admin` |
| `daemon.stop` | `admin` |
| `agent.register` | `admin` |
| `agent.list` | `restricted` |
| `agent.bind` | `privileged` |
| `agent.unbind` | `privileged` |
| `agent.status` | `restricted` |
| `agent.refresh` | `admin` |
| `agent.abort` | `admin` |
| `agent.set` | `privileged` |
| `agent.session-policy.set` | `privileged` |
| `team.register` | `privileged` |
| `team.set` | `privileged` |
| `team.add-member` | `privileged` |
| `team.remove-member` | `privileged` |
| `team.status` | `restricted` |
| `team.list` | `restricted` |
| `team.list-members` | `restricted` |
| `team.send` | `restricted` |
| `team.delete` | `admin` |

## Channel User Permission Policy

Hi-Boss authorizes channel-originated commands/messages with a
channel user policy stored at:

- `settings.json.user-permission-policy` (required; source-of-truth)
- mirrored to `config.user_permission_policy` in SQLite runtime cache

`user-permission-policy` is token-centric authorization:
- policy defines `users[]` entries (`name`, `token`, `role`, optional `agents`)
- `role: admin` implies access to all agents
- `role: user` must list allowed `agents[]`
- platform identity (e.g. Telegram user id) is authenticated at runtime via `/login <token>` and persisted in DB (`channel_user_auth`)
- command/message access is decided by the logged-in token's role/scope against the adapter's bound target agent
