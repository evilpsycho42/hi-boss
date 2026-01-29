# Hi-Boss Developer / Agent Guide

Hi-Boss is a local daemon + `hiboss` CLI for routing messages (“envelopes”) between agents and chat channels (e.g., Telegram).

## Must-do (after code changes)

```bash
npm run build && npm link
```

## Fast path (dev)

```bash
npm i
npm run build && npm link

hiboss setup
hiboss daemon start --debug
hiboss agent register --name nex --description "AI assistant" --workspace "$PWD"
```

## E2E tests (no adapters)

Automated (runs in a temp `$HOME`, does **not** require OpenAI/Anthropic keys):

```bash
npm run e2e
```

Notes:
- Uses `HIBOSS_E2E=1` to mock agent/background runs (so envelope/session/scheduler mechanisms are testable offline).
- Uses `HIBOSS_DISABLE_AGENT_AUTO_RUN=1` for one phase to verify `hiboss envelope list --as-turn`, then restarts the daemon to verify startup recovery + auto-run.
- Memory is smoke-tested via `hiboss mem state` only. Avoid `hiboss mem add/search` unless embeddings are configured (it may download a large model).

Manual (real home):
- Build/link, reset state, run setup, start daemon, then follow `docs/spec/cli.md` and check `~/.hiboss/daemon.log` + DB.

## Naming rules (parsing safety)

| Context | Convention | Example |
|---------|------------|---------|
| Code (TypeScript) | camelCase | `envelope.fromBoss` |
| CLI flags | kebab-case, lowercase | `--deliver-at` |
| CLI output keys | kebab-case, lowercase | `from-name:` |
| Agent instructions | kebab-case, lowercase | `from-boss` |

Rule: CLI flags, CLI output keys, and agent instructions **must** all stay kebab-case so agents can parse output without translation.

Canonical mapping:
```
envelope.deliverAt  -> --deliver-at   (flag)
envelope.fromBoss   -> --from-boss    (flag; boss token only)
envelope.createdAt  -> created-at:    (output key; direct/agent messages only)
```

Boss marker:
- When `fromBoss` is true, rendered sender lines include the `[boss]` suffix:
  - direct: `from-name: <author> [boss]`
  - group: `Author [boss] at <timestamp>:`

## Core operational rules

- Tokens are printed once by `hiboss setup` / `hiboss agent register` (there is no “show token” command).
- Sending to `channel:<adapter>:...` is only allowed if the sending agent is bound to that adapter type.
- `--deliver-at` supports relative (`+2h`, `+1Y2M3D`) and ISO 8601; units are case-sensitive (`Y/M/D/h/m/s`).

## State & debugging

| Item | Path |
|------|------|
| State dir | `~/.hiboss/` |
| DB | `~/.hiboss/hiboss.db` |
| IPC socket | `~/.hiboss/daemon.sock` |
| Daemon log | `~/.hiboss/daemon.log` |

Reset: `hiboss daemon stop && rm -rf ~/.hiboss && hiboss setup`

## Docs policy

- Specs: `docs/spec/` (developer-facing; implementations must align)
- Guides: `docs/guide/` and root `README.md` (user-facing; readable/concise)

Start here: `docs/index.md` and `docs/spec/definitions.md`.
