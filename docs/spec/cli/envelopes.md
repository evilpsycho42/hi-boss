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
- `--reply-to <channel-message-id>` (optional; channel destinations only; for Telegram, use the compact base36 id shown as `channel-message-id:` / `in-reply-to-channel-message-id:` in prompts; raw decimal can be passed as `dec:<id>`)
- `--parse-mode <mode>` (optional; channel destinations only; `plain|markdownv2|html`)
- `--deliver-at <time>` (ISO 8601 or relative: `+2h`, `+30m`, `+1Y2M`, `-15m`; units: `Y/M/D/h/m/s`)

Notes:
- Sender identity is derived from the authenticated **agent token**.
- Boss tokens cannot send envelopes via `hiboss envelope send`; to message an agent as a human/boss, send via a channel adapter (e.g., Telegram).

Output (parseable):

```
id: <envelope-id>
```

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

Note:
- Envelopes are marked `done` automatically by the daemon after successful delivery (channels) or a successful agent run (agents).

Flags:
- `--address <address>` (boss token only)
- `--box inbox|outbox`
- `--status pending|done`
- `-n, --limit <n>`

Default permission:
- `restricted`
