# CLI: Memory

Hi-Boss provides per-agent **semantic memory** backed by LanceDB.

If memory is disabled or misconfigured, `memory.*` calls fail with an error that suggests running `hiboss memory setup`.

## `hiboss memory add`

Adds a memory entry (category optional; defaults to `fact`).

Flags:
- `--text <text>` (required)
- `--category <category>` (optional; defaults to `fact`)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`; override by passing `--token`)

Output (parseable):
- `id: <memory-id>`

Default permission:
- `restricted`

## `hiboss memory search`

Searches memories by semantic similarity (optional category filter).

Flags:
- `--query <query>` (required)
- `--category <category>` (optional)
- `-n, --limit <n>` (optional; default 5)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`; override by passing `--token`)

Output (parseable):
- `count: <n>`
- then repeated blocks with:
  - `id:`
  - `category:`
  - `created-at:`
  - `similarity:` (optional)
  - `text-json:`

Default permission:
- `restricted`

## `hiboss memory list`

Lists stored memories (newest-first by `created-at`).

Flags:
- `--category <category>` (optional)
- `-n, --limit <n>` (optional; default 100)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`; override by passing `--token`)

Output (parseable):
- `count: <n>`
- then repeated blocks (same shape as `memory.search` but without `similarity:`)

Default permission:
- `restricted`

## `hiboss memory categories`

Lists known memory categories (derived from stored memories).

Flags:
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`; override by passing `--token`)

Output (parseable):
- `count: <n>`
- `category: <category>` (one per line)

Default permission:
- `restricted`

## `hiboss memory get`

Gets a memory by id.

Flags:
- `--id <id>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `found: true|false`
- If found, a memory block (same as `memory.list`).

Default permission:
- `restricted`

## `hiboss memory delete`

Deletes a memory by id.

Flags:
- `--id <id>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `ok: true`

Default permission:
- `restricted`

## `hiboss memory delete-category`

Deletes all memories in the specified category.

Flags:
- `--category <category>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `ok: true`
- `deleted: <n>`

Default permission:
- `restricted`

## `hiboss memory clear`

Drops all memories for the target agent.

Flags:
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `ok: true`

Default permission:
- `standard`

## `hiboss memory setup`

Configures the local embedding model for semantic memory.

Flags:
- `--default` (download and use the default model)
- `--model-path <path>` (use a local GGUF model file)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `memory-enabled: true|false`
- `model-path: <path>|(none)`
- `dims: <n>`
- `last-error: <message>` (optional)

Default permission:
- `privileged`
