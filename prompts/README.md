<!--
@instructions

This directory is treated as the canonical source of prompt/instruction templates
used by the Hi-Boss CLI for agent-facing output.
-->

# Hi-Boss Instructions

Hi-Boss produces **agent input** as a plain-text *instruction* composed from template files.

By default, `hiboss envelope get` and `hiboss envelope list` render an envelope using the templates under
`@instructions/envelope/` (where `@instructions` resolves to `prompts`).

## Structure

An envelope instruction is rendered by concatenating these templates with a blank line between each section:

1. `@instructions/envelope/header.md`
2. `@instructions/envelope/text.md`
3. `@instructions/envelope/attachments.md`

All field keys MUST be **kebab-case, lowercase**, matching the CLI output naming convention.

## Template Variables

Templates use `{{...}}` placeholders. Example:

- `id: {{id}}`
- `from-boss: {{from-boss}}`

### Supported placeholders

| Placeholder | Meaning |
|------------|---------|
| `{{from}}` | Sender address |
| `{{to}}` | Destination address |
| `{{from-boss}}` | `true` or `false` |
| `{{created-at}}` | ISO 8601 timestamp |
| `{{text}}` | Envelope text, or `(none)` |
| `{{attachments}}` | Rendered attachment list, or `(none)` |

## Runtime Resolution

The CLI loads templates from `@instructions`:

- Default: `prompts` (auto-detected by locating `package.json`)
