# CLI: Envelopes

This document specifies `hiboss envelope ...`.

See also:
- `docs/spec/envelope.md` (envelope semantics and lifecycle)
- `docs/spec/definitions.md` (canonical output keys for instructions)
- `docs/spec/cli/reactions.md` (reacting to channel messages)

## `hiboss envelope send`

Sends an envelope to an agent or channel.

Flags:
- `--to <address>` (required)
- `--text <text>` or `--text -` (stdin) or `--text-file <path>`
- `--attachment <path>` (repeatable)
- `--reply-to <message-id>` (optional; channel destinations only)
- `--parse-mode <mode>` (optional; channel destinations only; `plain|markdownv2|html`)
- `--deliver-at <time>` (ISO 8601 or relative: `+2h`, `+30m`, `+1Y2M`, `-15m`; units: `Y/M/D/h/m/s`)
- Boss-only: `--from <address>`, `--from-boss`, `--from-name <name>`

Output (parseable):

```
id: <envelope-id>
```

Default permission:
- `restricted`

## `hiboss envelope get`

Gets an envelope by id and prints an agent-facing envelope instruction.

Rendering:
- `src/cli/instructions/format-envelope.ts` → `prompts/envelope/instruction.md`

Default permission:
- `restricted`

## `hiboss envelope list`

Lists envelopes (defaults: `--box inbox`).

Empty output:

```
no-envelopes: true
```

Rendering (default):
- Prints one envelope instruction per envelope, separated by a blank line.
- Each envelope is formatted by `formatEnvelopeInstruction()` using `prompts/envelope/instruction.md`.

Flags:
- `--address <address>` (boss token only)
- `--box inbox|outbox`
- `--status pending|done`
- `--limit <n>` (or deprecated `--n <n>`)

Default permission:
- `restricted`

## `hiboss envelope list --as-turn`

Prints a **turn preview** (same format as agent turn input).

Constraints:
- Requires `--box inbox --status pending` (the CLI enforces this).
- Boss token must specify the target agent via `--address agent:<name>`.

Meaning:
- Uses pending, due inbox envelopes for the agent (oldest first, same selection as agent runs).
- Consecutive group-chat envelopes with the same `from:` are batched under one `### Envelope <index>` header.

Note:
- `## Pending Envelopes (...)` shows the number of underlying messages, and when batching occurs it also shows the number of grouped blocks (so it can differ from the number of `### Envelope <index>` headers).

Default permission:
- `restricted`
