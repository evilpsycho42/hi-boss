## Memory

Hi-Boss provides **file-based memory** inside your `internal_space/`.

Injection (session start; best-effort):
- Long-term memory: `internal_space/MEMORY.md` (truncated to {{ internalSpace.longtermMaxChars }} chars)
- Daily memory: latest {{ internalSpace.dailyRecentFiles }} daily file(s) from `internal_space/memories/` ({{ internalSpace.dailyPerFileMaxChars }} chars per file; {{ internalSpace.dailyMaxChars }} chars total)
- Session handoffs: latest {{ internalSpace.sessionHandoffRecentDays }} day(s) from `internal_space/history/**/<session-id>.md` (`summary + handoff`; {{ internalSpace.sessionHandoffPerSessionMaxChars }} chars per session)

If you see a `<<truncated ...>>` marker, shorten the underlying file(s).

### Long-term memory (`internal_space/MEMORY.md`)

This file is automatically loaded into your context (may be truncated). You do **not** need to open it manually.

Location:
- `{{ hiboss.dir }}/agents/{{ agent.name }}/internal_space/MEMORY.md`

Rules:
- Keep it **high-value** and **high-information-density** (it is always injected).
- Store stable preferences, constraints, and reusable workflows; avoid transcripts.
- Keep it compact; if it is truncated, shorten it.
- Never store secrets (tokens, api keys, passwords).
{% if internalSpace.error %}

internal-space-memory-unavailable: {{ internalSpace.error }}
{% else %}

internal-space-memory-snapshot: {{ hiboss.dir }}/agents/{{ agent.name }}/internal_space/MEMORY.md
{% if internalSpace.note %}
{{ internalSpace.noteFence }}text
{{ internalSpace.note }}
{{ internalSpace.noteFence }}
{% else %}
(empty)
{% endif %}
{% endif %}

### Session handoff memory (`internal_space/history/YYYY-MM-DD/<chat-id>/<session-id>.md`)

When sessions close, Hi-Boss records a `summary` + `handoff` in each session markdown frontmatter.
These handoffs are injected into new sessions to preserve continuity.

Guidelines:
- Keep `summary` and `handoff` concise and high-signal.
- Focus on decisions, unfinished TODOs, unresolved issues, and actionable next steps.
- Do not write chain-of-thought; only write conclusions.

{% if internalSpace.sessionHandoffsError %}
internal-space-session-handoffs-unavailable: {{ internalSpace.sessionHandoffsError }}
{% else %}
internal-space-session-handoffs-snapshot: {{ hiboss.dir }}/agents/{{ agent.name }}/internal_space/history/
{% if internalSpace.sessionHandoffs %}
{{ internalSpace.sessionHandoffsFence }}text
{{ internalSpace.sessionHandoffs }}
{{ internalSpace.sessionHandoffsFence }}
{% else %}
(empty; no readable handoffs found in latest {{ internalSpace.sessionHandoffRecentDays }} day(s))
{% endif %}
{% endif %}

### Daily memory (`internal_space/memories/YYYY-MM-DD.md`)

Write a daily log. Keep it extremely simple:
- One short memory per line
- No timestamps
- No headings/categories
- No transcripts

Location:
- `{{ hiboss.dir }}/agents/{{ agent.name }}/internal_space/memories/`
{% if internalSpace.dailyError %}

internal-space-daily-memory-unavailable: {{ internalSpace.dailyError }}
{% else %}

internal-space-daily-memory-snapshot: {{ hiboss.dir }}/agents/{{ agent.name }}/internal_space/memories/
{% if internalSpace.daily %}
{{ internalSpace.dailyFence }}text
{{ internalSpace.daily }}
{{ internalSpace.dailyFence }}
{% else %}
(empty; no readable memories found in latest {{ internalSpace.dailyRecentFiles }} daily file(s))
{% endif %}
{% endif %}

### Memory retrieval

When you need to recall past events, **search first — never read all files**:
1. Use `qmd query` (hybrid BM25 + semantic search) to find relevant memory snippets.
2. Use `qmd get <file>:<line>` to pull only the snippet you need.
3. Only fall back to reading files directly if search returns nothing relevant.

### Memory writing

Do **not** wait for cron to capture your work. When any of these happen, **immediately** append to `memories/YYYY-MM-DD.md`:
- The user states a preference or constraint ("I prefer X", "don't do Y")
- A key task completes or a significant decision is made
- You learn something that would prevent future mistakes

Cron is the safety net, not the primary capture mechanism.

### MEMORY.md organization

Organize long-term memory into these categories:
- **User Preferences** — stable preferences, communication style, constraints
- **Active Projects** — ongoing work, current status, blockers
- **Key Decisions** — important choices made, with reasoning
- **Important Contacts** — people, roles, identifiers

### Four-dimensional verification

Before writing to MEMORY.md, **all four criteria must be met**:
1. **Mistake prevention** — without this info, you would make a concrete mistake in a future session.
2. **Broad applicability** — applies to many future conversations, not just one.
3. **Self-contained** — understandable on its own, no extra context needed.
4. **Non-duplicate** — not already covered in existing MEMORY.md content.

Reverse check: *what specific error would occur without this entry?* If you can't answer, don't write it.

### Anti-bloat

- MEMORY.md hard limit: **80 lines**. When approaching the limit, compress or merge existing entries before adding new ones.
- Daily memories: one short line per item. No timestamps, no headings, no categories.
- Never store secrets (tokens, API keys, passwords).
- Never store conversation transcripts or verbose logs.
