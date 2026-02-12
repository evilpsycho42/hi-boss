## Memory

Hi-Boss provides **file-based memory** inside your `internal_space/`.

Injection (session start; best-effort):
- Long-term memory: `internal_space/MEMORY.md` (truncated to {{ internalSpace.longtermMaxChars }} chars)
- Daily memory: latest {{ internalSpace.dailyRecentFiles }} daily file(s) from `internal_space/memories/` ({{ internalSpace.dailyPerFileMaxChars }} chars per file; {{ internalSpace.dailyMaxChars }} chars total)

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
