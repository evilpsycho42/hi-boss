# Skills

This document specifies Hi-Boss skill layering: built-in skills shipped with Hi-Boss, user-defined global skills, and agent-local skills inside provider homes.

See also:
- `docs/spec/components/agent.md` (agent homes and provider `skills/` directories)
- `docs/spec/configuration.md` (default `HIBOSS_DIR`)

## Goals

- Ship a small set of **built-in skills** with Hi-Boss and keep them up-to-date when users upgrade Hi-Boss.
- Allow users to define **global skills** that are automatically available to all agents.
- Allow each agent (or user) to define **agent-local skills** that override global/built-in behavior.
- Be **safe and low-surprise**: do not delete or overwrite user-managed skills by default.
- Be **low-friction** for end users: “it just works” without extra commands after install/upgrade.

## Non-goals

- A full skill package manager (version pinning, dependency resolution, etc.).
- Auto-merging or partially updating user-authored skill files.

## Terms

- **Skill**: a directory under a provider home’s `skills/` folder containing `SKILL.md` and any supporting files.
- **Built-in skills**: shipped with Hi-Boss; maintained by the Hi-Boss project; stored under the global `.system` directory.
- **Global skills**: user-maintained skills under the global `skills/` directory (excluding `.system`).
- **Agent-local skills**: user/agent-maintained skills in an individual agent’s provider home `skills/` directory.
- **Managed skill directory**: a skill directory that Hi-Boss previously injected into an agent provider home and is therefore eligible for safe overwrite by Hi-Boss.

## Directory layout

Hi-Boss uses a three-layer directory model (default `HIBOSS_DIR=~/hiboss`):

1) Built-in (Hi-Boss managed, global):

```
${HIBOSS_DIR}/skills/.system/<skill-name>/
```

2) User global (user managed, global):

```
${HIBOSS_DIR}/skills/<skill-name>/
```

3) Agent-local (user/agent managed, per agent + provider):

```
${HIBOSS_DIR}/agents/<agent-name>/<provider>_home/skills/<skill-name>/
```

Notes:
- The `.system` directory is reserved for Hi-Boss built-ins and may be overwritten on daemon start.
- Agent provider homes MUST NOT use a `.system/` namespace for Hi-Boss injection. Skills are injected directly under the provider home’s `skills/` root.

## Precedence (name conflicts)

When two layers contain the same `<skill-name>`, the effective precedence is:

```
agent-local > global > built-in
```

This is enforced by only allowing Hi-Boss to overwrite **managed** injected skill directories and never overwriting un-managed (agent-local) skill directories.

## Managed skill marker

Hi-Boss marks skill directories that it injected into an agent provider home by writing a small marker file at:

```
<provider-home>/skills/<skill-name>/.hiboss-managed.json
```

Requirements:
- The marker file MUST NOT affect provider behavior. It is purely Hi-Boss metadata.
- Sync MUST treat directories without this marker as agent-local (user managed).

Suggested fields (stable keys, kebab-case not required here; it is not a CLI surface):

```json
{
  "owner": "hiboss",
  "layer": "builtin",
  "source": "hiboss-global-builtin",
  "updatedAtMs": 0
}
```

Where `layer` is `builtin` or `global`.

## Lifecycle

### When sync runs (and when it must not)

Hi-Boss MUST sync skills only when creating a brand-new provider session, not per conversation turn.

Required sync points:
- **Daemon start**: seed global built-in skills into `${HIBOSS_DIR}/skills/.system`.
- **Session create**: before opening a brand-new provider session for an agent, inject skills into the agent provider home.
- **Session refresh**: when a refresh is requested (e.g. Telegram `/new`) and a new session will be created, inject skills for the new session.

Forbidden/avoid by default:
- Sync on every agent turn / every envelope run. This increases I/O and surprises, and is not needed for correctness.
- Sync when attaching/resuming an existing provider session handle (resume/reload). This keeps the rule simple: only new sessions get a deterministic skill snapshot.

### 1) Daemon start: seed global built-in skills

On daemon start, Hi-Boss seeds the global built-in skills directory:

- Source: the Hi-Boss npm package ships built-ins under:

```
assets/skills/.system/*
```

- Destination:

```
${HIBOSS_DIR}/skills/.system
```

Default behavior:
- Treat `${HIBOSS_DIR}/skills/.system` as fully managed by Hi-Boss.
- Replace it wholesale (clean directory) to ensure there are no stale files after upgrades.
- Never touch `${HIBOSS_DIR}/skills/*` (user global skills).

Safety requirements:
- Only operate within `${HIBOSS_DIR}/skills/.system`.
- Refuse to operate if the target is a symlink.
- Prefer an atomic swap approach:
  - copy to a temp dir
  - rename/swap into place
  - remove old dir

### 2) Session create/refresh: inject global skills into agent provider home

Before opening a brand-new provider session for an agent (including session refresh that creates a new session), Hi-Boss performs skill injection into:

```
${HIBOSS_DIR}/agents/<agent-name>/<provider>_home/skills/
```

Sync order (must be deterministic):

1. Inject built-in layer from `${HIBOSS_DIR}/skills/.system/*`
2. Inject global layer from `${HIBOSS_DIR}/skills/*` (excluding `.system`)

Per-skill overwrite rules:

Let `dest = <provider-home>/skills/<skill-name>/`.

Built-in injection:
- If `dest` does not exist: copy; write marker `{ layer: "builtin" }`.
- If `dest` exists without marker: skip (agent-local wins).
- If `dest` exists with marker and `layer=builtin`: overwrite (keep built-in updated).
- If `dest` exists with marker and `layer=global`: skip (global already overrides built-in).

Global injection:
- If `dest` does not exist: copy; write marker `{ layer: "global" }`.
- If `dest` exists without marker: skip (agent-local wins).
- If `dest` exists with marker and `layer=global`: overwrite (keep global updated).
- If `dest` exists with marker and `layer=builtin`: overwrite (global overrides built-in) and update marker to `{ layer: "global" }`.

Implementation notes:
- Use an atomic per-skill directory swap (copy to `__tmp__`, then rename) to avoid partial updates.
- Do not delete arbitrary directories under provider `skills/` since it may contain agent-local user content.

## Built-in skills inventory

Hi-Boss built-in skills are shipped with the npm package and maintained by the Hi-Boss project.

| Skill name | Purpose | Source (optional) |
|-----------|---------|-------------------|
| `agent-browser` | Web browsing / page extraction workflow | `https://github.com/vercel-labs/agent-browser/tree/main/skills/agent-browser` |

Source links are advisory metadata for maintainers and may be absent for Hi-Boss-authored skills.
