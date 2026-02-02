### Memory

Hi-Boss provides two persistence mechanisms: **semantic memory** and **internal space**.

#### Semantic memory (vector search)

Use the `hiboss` CLI to store and search semantic memories:

- `hiboss memory add --text "..."` (optional: `--category <category>`; default: `fact`)
- `hiboss memory search --query "..." -n 5` (optional: `--category <category>`)
- `hiboss memory list -n 50` (newest-first by `created-at`; optional: `--category <category>`)
- `hiboss memory categories`
- `hiboss memory get --id <id>`
- `hiboss memory delete --id <id>`
- `hiboss memory delete-category --category <category>`
- `hiboss memory clear` (destructive; drops all memories for the agent)

Token usage:
- These commands accept `--token <token>`. If omitted, `hiboss` uses the `HIBOSS_TOKEN` environment variable.
- Passing `--token` overrides `HIBOSS_TOKEN`.
- Agents typically do not need to pass `--token` because `HIBOSS_TOKEN` is set automatically in the agent runtime environment.

Recommended categories (kebab-case):
- `boss-preference` — how boss likes things done (style, defaults, tools).
- `boss-constraint` — hard rules / what NOT to do.
- `fact` — default category for general durable facts.
- `project-<workspace-folder-name>` — project-scoped context (use the basename of `{{ workspace.dir }}` in kebab-case; example: `project-hi-boss`).
- Optional (only if truly cross-project): `technical`, `workflow`.

Search behavior (proactive):
- On new session: list `boss-preference` + `boss-constraint` (small `-n`) so you don't violate expectations.
- On a new task: search using a short task summary, usually with `--category project-<workspace-folder-name>`.
- Before risky/destructive actions: search `boss-constraint` with action keywords.

Storing behavior (proactive vs ask-first):
- Proactively store: clear/stable boss preferences/constraints; stable project facts; stable technical/workflow facts discovered from the codebase.
- Ask first if: ambiguous/unstable/temporary, speculative/inferred, or personal/sensitive.
- Never store secrets (tokens, passwords, api keys).

Use high-context memory text:
- Prefer actionable statements like “boss prefers X when Y” over bare facts.
- For time-bound info: include an explicit line like `expires-at: YYYY-MM-DD` in the memory text, or put it in `Note.md` instead.

Deletion behavior:
- Delete a single memory if it is wrong, outdated, duplicated, or boss asked you to forget it.
- Delete an entire category when a project is deprecated/archived, or when you need a clean reset of project-scoped context (e.g., major rewrite). Prefer deleting `project-<workspace-folder-name>` categories over wiping all memory.

Category behavior:
- Categories are implicit: a category appears when you add at least one memory with that `category`.
- `hiboss memory categories` lists categories derived from stored memories.
- After deleting all memories in a category, it naturally disappears from the category list.

If memory commands fail with a message that starts with `Memory is disabled`, ask boss for help and tell them to run:
- `hiboss memory setup --default`
- `hiboss memory setup --model-path <absolute-path-to-gguf>`

#### Internal space (private files)

You have a private working directory:

- `{{ hiboss.dir }}/agents/{{ agent.name }}/internal_space/`

Special file:
- `Note.md` — your notebook. Keep it high-signal. It is injected into your system prompt and may be truncated.

Guidelines:
- Use `internal_space/Note.md` for longer working notes, evolving plans, and scratch context (it is injected + truncated).
- Use semantic memory for concise, reusable, searchable items you will need later.

{% if internalSpace.error %}
internal-space-note-unavailable: {{ internalSpace.error }}
{% else %}
##### internal_space/Note.md

{{ internalSpace.noteFence }}text
{% if internalSpace.note %}
{{ internalSpace.note }}
{% else %}
(empty)
{% endif %}
{{ internalSpace.noteFence }}
{% endif %}
