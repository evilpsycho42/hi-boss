<!--
This directory is the canonical source of prompt/instruction templates used by Hi-Boss.
-->

# Hi-Boss Prompts

Hi-Boss uses **Nunjucks** (Jinja-like) templates under `prompts/` to generate three kinds of text:

1. **System instructions** (agent bootstrap / “system prompt”)
2. **Turn input** (what the agent SDK receives each run)
3. **CLI envelope instructions** (what `hiboss envelope get/list` prints for agents to read)

All agent-facing **keys** in rendered text must remain **kebab-case, lowercase** (e.g. `from-boss:`).

---

## Prompt Surfaces

### 1) System instructions

- Entrypoint: `prompts/system/base.md`
- Rendered by: `src/agent/instruction-generator.ts`
- Written to:
  - `~/.hiboss/agents/<agent-name>/codex_home/AGENTS.md`
  - `~/.hiboss/agents/<agent-name>/claude_home/CLAUDE.md`

Note: system instructions are regenerated when a new session is created (e.g. after `/new` or session refresh policies).

### 2) Turn input

- Entrypoint: `prompts/turn/turn.md`
- Rendered by: `src/agent/turn-input.ts`

Turn input changes apply immediately on the next agent run.

### 3) CLI envelope instructions

- Entrypoint: `prompts/envelope/instruction.md`
- Rendered by: `src/cli/instructions/format-envelope.ts`

This is the agent-facing text emitted by:
- `hiboss envelope get`
- `hiboss envelope list`

---

## Composition Diagram

```mermaid
flowchart TD
  A[Daemon triggers agent run] --> B[Build turn context + envelopes]
  B --> C[Render prompts/turn/turn.md]
  C --> D[Agent SDK session.run(input)]

  E[New session / refresh] --> F[Build system context]
  F --> G[Render prompts/system/base.md]
  G --> H[Write AGENTS.md / CLAUDE.md]
  H --> D

  I[CLI: hiboss envelope get/list] --> J[Build envelope context]
  J --> K[Render prompts/envelope/instruction.md]
  K --> L[Printed to stdout]
```

---

## Template Language (Nunjucks)

- Variables: `{{ agent.name }}`
- Conditionals:
  - `{% if envelope.fromName %}...{% endif %}`
- Loops:
  - `{% for env in envelopes %}...{% endfor %}`
- Includes:
  - `{% include "turn/sections/envelope.md" %}`

Undefined variables throw at render time (to catch typos early).

---

## Template Variables

See `prompts/VARIABLES.md` for the authoritative variable catalog per surface.

---

## Customization (Hi-Boss Files)

System instructions can include optional files from Hi-Boss’s state directory (default `~/.hiboss`):

- `~/.hiboss/USER.md` — user profile (shared across agents)
- `~/.hiboss/agents/<agent-name>/SOUL.md` — persona / tone / boundaries (per-agent)

These files are injected into `prompts/system/base.md`.
