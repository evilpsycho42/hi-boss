## Tools

### Memory (`hiboss mem`)

`hiboss mem` is the built-in memory CLI (mem-cli). It stores memory locally as Markdown and keeps a SQLite vector index for **semantic retrieval**.

#### How memory works in Hi-Boss

- Two workspaces:
  - **Private (default)**: per-agent memory keyed by your Hi-Boss token (already injected; no `--token` needed).
  - **Public (shared)**: opt-in via `--public`.
- On every new session, Hi-Boss injects a snapshot into the system prompt (`## Memory`):
  - **Long-term**: `MEMORY.md` (truncated if too long)
  - **Short-term**: recent daily logs (last 2 days)
- `hiboss mem search` performs semantic retrieval across **both** long-term + short-term memory.

#### Safety rules

- Never print or share your token.
- Do **not** edit `~/.mem-cli/settings.json` (it affects all workspaces).
- Avoid `hiboss mem reindex` / `hiboss mem reindex --all` (expensive). Indexing updates automatically on `add`/`search`; ask your boss before running manual reindex.

#### How to use it

Private (default):

```bash
# If you see "Workspace not initialized", run:
hiboss mem init

# Short-term (daily)
hiboss mem add short "..."

# Long-term (curated)
hiboss mem add long "..."
echo "..." | hiboss mem add long --stdin

# Semantic retrieval (searches both long + short)
hiboss mem search "query"
```

Public (shared):

```bash
hiboss mem add short "..." --public
hiboss mem add long "..." --public
hiboss mem search "query" --public
```

#### Where files live (you may edit them directly)

Private (per agent):
- Long-term: `{{ hiboss.dir }}/agents/{{ agent.name }}/.mem-cli/MEMORY.md`
- Short-term: `{{ hiboss.dir }}/agents/{{ agent.name }}/.mem-cli/memory/YYYY-MM-DD.md`

Public (shared):
- Long-term: `~/.mem-cli/public/MEMORY.md`
- Short-term: `~/.mem-cli/public/memory/YYYY-MM-DD.md`

#### How to use it better

- Keep `MEMORY.md` short and high-signal (it’s truncated when injected). Prefer concise bullet points and remove stale/duplicate items.
- Use `hiboss mem search` before answering when prior context/preferences might matter.
- Save stable preferences/decisions in long-term memory; put ephemeral notes in daily logs.
