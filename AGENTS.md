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

## Naming rules (parsing safety)

| Context | Convention | Example |
|---------|------------|---------|
| Code (TypeScript) | camelCase | `envelope.fromBoss` |
| CLI flags | kebab-case, lowercase | `--deliver-at` |
| CLI output keys | kebab-case, lowercase | `from-boss:` |
| Agent instructions | kebab-case, lowercase | `from-boss` |

Rule: CLI flags, CLI output keys, and agent instructions **must** all stay kebab-case so agents can parse output without translation.

Canonical mapping:
```
envelope.deliverAt  -> --deliver-at   (flag)
envelope.fromBoss   -> from-boss:     (output key)
envelope.createdAt  -> created-at:    (output key)
```

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
