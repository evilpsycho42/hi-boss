# Config: Data Directory Layout

Default root:
- `~/hiboss/` (override via `HIBOSS_DIR`)

Operator-visible files:
- `{{HIBOSS_DIR}}/BOSS.md` — optional boss profile
- `{{HIBOSS_DIR}}/media/` — downloaded attachments (e.g., Telegram)
- `{{HIBOSS_DIR}}/agents/<agent-name>/SOUL.md` — optional per-agent persona
- `{{HIBOSS_DIR}}/agents/<agent-name>/internal_space/MEMORY.md` — per-agent memory file injected into system instructions (may be truncated)

Internal daemon files (do not touch):
- `{{HIBOSS_DIR}}/.daemon/hiboss.db` — SQLite DB (durable queue + audit)
- `{{HIBOSS_DIR}}/.daemon/daemon.sock` — IPC socket
- `{{HIBOSS_DIR}}/.daemon/daemon.lock` — single-instance lock
- `{{HIBOSS_DIR}}/.daemon/daemon.pid` — PID (informational)
- `{{HIBOSS_DIR}}/.daemon/daemon.log` — current daemon log
- `{{HIBOSS_DIR}}/.daemon/log_history/` — archived daemon logs
- `{{HIBOSS_DIR}}/.daemon/memory.lance/` — LanceDB storage (semantic memory)
- `{{HIBOSS_DIR}}/.daemon/models/` — embedding model downloads (semantic memory)

Note: there is no `--data-dir` flag; use `HIBOSS_DIR`.

Provider CLI homes are not part of the Hi-Boss data directory:
- Claude: `~/.claude`
- Codex: `~/.codex`

Provider-home behavior (including cleared override env vars) is canonical in `docs/spec/provider-clis.md#provider-homes-shared-forced`.
