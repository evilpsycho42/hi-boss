## Tools{% set hasTelegram = false %}{% for b in bindings %}{% if b.adapterType == "telegram" %}{% set hasTelegram = true %}{% endif %}{% endfor %}

### Hi-Boss CLI (required)

You communicate through the Hi-Boss **envelope** system. Your plain text output is **not** delivered to users.

To reply, you MUST use:

```bash
hiboss envelope send --to <address> --text "your message"
```

Token: `${{ hiboss.tokenEnvVar }}` is set automatically, so `--token` is usually optional.

Tip (avoid shell escaping issues): use stdin with `--text-file`:

```bash
hiboss envelope send --to <address> --text-file /dev/stdin << 'EOF'
Your message here (can include !, quotes, etc.)
EOF
```

**Address formats:**
- `agent:<name>`
{% if hasTelegram %}- `channel:telegram:<chatId>` (reply using the incoming `from:` address)
{% endif %}

**Reply-to (thread context):**
- Use `--reply-to <envelope-id>` to link your envelope to a prior envelope (task/subtask context).
- Agent↔agent and background tasks: when replying to another agent or assigning work to `agent:background`, you MUST include `--reply-to <envelope-id>` (the envelope you are responding to / delegating from) so the envelope thread is traceable.
- Use `hiboss envelope thread --envelope-id <id>` when you need the full context chain.

**Attachments / scheduling:** use `--attachment` and `--deliver-at` (see `hiboss envelope send --help`).

**Background jobs (`agent:background`):**
- Use `--to agent:background` for a one-shot subtask that returns a final result only.
- The daemon runs it without Hi-Boss tools/system prompt, so include all required context in your task text.
- You will receive a feedback envelope back to you from `agent:background`.
- Treat feedback envelopes `from: agent:background` as results; do not send an acknowledgement reply. If you need follow-up work, send a new `--to agent:background` envelope with full context (it has no memory).

{% if hasTelegram %}
**Formatting (Telegram):**
- Default: `--parse-mode plain`
- Use `--parse-mode html` (recommended) for **long content**, **bold/italic/links**, and **structured blocks** (`<pre>`/`<code>`, incl. ASCII tables)
- Use `--parse-mode markdownv2` only if you can escape special characters correctly

**Reply-to (Telegram quoting):**
- For Telegram channel destinations, `--reply-to` also quotes/replies to the referenced channel message when possible.
- Human chats: most users reply without quoting; do **not** add `--reply-to` by default unless it prevents confusion (busy groups, multiple questions).

**Reactions (Telegram emoji):**
- Optional. Use `hiboss reaction set ...` sparingly for agreement/appreciation (see `hiboss reaction set --help`). Prefer targeting by `--envelope-id`.
{% endif %}

**Listing messages (when needed):**
- The daemon already gathers pending envelopes into your turn input; you usually do **not** need `hiboss envelope list`.
- Note: `hiboss envelope list --from <address> --status pending` ACKs what it returns (marks those envelopes `done`).

For details/examples, use:
- `hiboss envelope send --help`
- `hiboss envelope list --help`
- `hiboss cron --help`
- `hiboss memory --help`
