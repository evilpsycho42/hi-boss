---
name: hiboss-mem
description: Use `hiboss mem` (mem-cli) to manage per-agent private memory using the Hi-Boss token (`$HIBOSS_TOKEN`). Hi-Boss initializes workspaces automatically; use this to add memories and run semantic search for retrieval.
---

# hiboss-mem (Agent Memory)

`hiboss mem` is a passthrough to `mem-cli`, bundled with Hi-Boss.

## Agent safety rules

- Never print or share your token.
- Do **not** edit `~/.mem-cli/settings.json` (it affects all workspaces).
- Do **not** run `hiboss mem reindex` / `hiboss mem reindex --all`. If indexing seems stale or settings changed, ask the boss to run reindex manually.

## Quick start (private per-agent memory)

Hi-Boss initializes memory workspaces automatically:
- Setup: public workspace
- Agent register: private workspace (per agent token)

If you see "Workspace not initialized", run:
- `hiboss mem init`

Add memories:
   - Daily entry (appends raw Markdown): `hiboss mem add short "..."`
   - Long-term memory (appends to `MEMORY.md`): `echo "..." | hiboss mem add long --stdin`

Search (semantic):
   - `hiboss mem search "query"`

Public (shared) workspace:
- `hiboss mem search "query" --public`

## Storage model (what gets indexed)

- Long-term memory: `MEMORY.md`
- Daily logs: `memory/YYYY-MM-DD.md` (plain Markdown; no required structure)
- Index DB: `index.db`

By default, mem-cli stores workspaces under `~/.mem-cli/`:
- Hi-Boss private (per agent): `~/.hiboss/agents/<agent-name>/.mem-cli/`
- Public (shared): `~/.mem-cli/public/`

## Debugging and troubleshooting

- Check workspace stats: `hiboss mem state`
- If embeddings fail to load (missing `node-llama-cpp` / invalid model path), `hiboss mem search` will error. Ask the boss to fix local embeddings setup.
- Daemon: by default, `hiboss mem add|search` runs via a background daemon to keep embeddings loaded. Disable with `MEM_CLI_DAEMON=0`. To reset (advanced), run `hiboss mem __daemon --shutdown`.
