# Config: Environment Variables

## `HIBOSS_TOKEN`

Default token for CLI commands when `--token` is omitted (agent or boss token).

Used by most commands that talk to the daemon, including:
- `hiboss envelope send`
- `hiboss envelope list`
- `hiboss agent ...`
- `hiboss daemon ...`

## `HIBOSS_DIR`

Overrides the Hi-Boss root directory (default: `~/hiboss`).

Notes:
- Must be an absolute path, or start with `~`.
- The daemon stores internal state under `{{HIBOSS_DIR}}/.daemon/`.

---

## Provider CLI homes

Provider-home behavior is canonical in `docs/spec/provider-clis.md#provider-homes-shared-forced`.

Environment guarantee:
- Hi-Boss clears `CLAUDE_CONFIG_DIR` and `CODEX_HOME` when spawning provider processes.
