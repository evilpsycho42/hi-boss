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
id: <envelope-id>  # short id
```

Default permission:
- `restricted`

## `hiboss envelope list`

Lists envelopes relevant to the authenticated agent.

Empty output:

```
no-envelopes: true
```

Rendering (default):
- Prints one envelope instruction per envelope, separated by a blank line.
- Each envelope is formatted by `formatEnvelopeInstruction()` using `prompts/envelope/instruction.md`.
- Envelope instructions include `status: pending|done` in the header so agents can avoid reprocessing already-handled items.

Notes:
- Envelopes are marked `done` automatically by the daemon after successful delivery (channels) or immediately after being read for an agent run (agents, at-most-once).
- `hiboss envelope list` only lists envelopes where the authenticated agent is either the sender (`from: agent:<name>`) or the recipient (`to: agent:<name>`).
- Listing with `--from <address> --status pending` is treated as a work-queue read: the daemon immediately acknowledges the returned envelopes (marks them `done`, at-most-once) so they won’t be reprocessed.
- Boss tokens cannot list envelopes (use an agent token).

Flags:
- Exactly one of:
  - `--to <address>`: list envelopes sent **by this agent** to `<address>`
  - `--from <address>`: list envelopes sent **to this agent** from `<address>`
- `--status <pending|done>` (required)
- `-n, --limit <n>` (default: `10`, max: `50`)

Default permission:
- `restricted`
