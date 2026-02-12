# Provider CLI Manual Experiments

This document records dated, manual experiments and CLI gotchas for provider CLIs used by Hi-Boss.

Canonical behavior spec:
- `docs/spec/provider-clis.md`

Third-party reference docs:
- `docs/refs/providers/README.md`

## Versions tested

Test date: **2026-02-10**

- Claude Code CLI: `claude` **2.1.37**
- Codex CLI: `codex` **0.98.0** (`codex-cli 0.98.0`)

## CLI help (what to read first)

```bash
claude -h
codex exec -h
codex exec resume -h
```

Gotcha observed (Claude):
- `--allowedTools` / `--disallowedTools` are variadic and can accidentally consume the prompt argument. Prefer stdin or `--`.

## JSON output (notes for parsers)

Claude:
- Prefer `--output-format stream-json` with `--verbose`.
- Session id comes from JSON output (`session_id`).

Codex:
- `codex exec --json` prints JSONL events to stdout; logs go to stderr.
- Thread id comes from the first `thread.started` event (`thread_id`).

## Session persistence and resume (manual)

Claude:

```bash
sid="$(claude -p --output-format json --model haiku 'one' | jq -r .session_id)"
claude -p --output-format json --model haiku -r "$sid" "two"
```

Codex:

```bash
codex exec --json --skip-git-repo-check "hi" | tee out.jsonl
thread_id="$(jq -r 'select(.type=="thread.started")|.thread_id' < out.jsonl)"
codex exec resume --json --skip-git-repo-check "$thread_id" "second turn"
```

Gotcha observed:
- `codex exec resume` does not accept `--add-dir` and does not inherit `-m` from the original session; pass model explicitly when needed.

## Recorded experiment: two-turn websearch -> write file

Two-turn smoke test (turn 1: WebSearch, turn 2: write findings to file). Test date: 2026-02-10.

Extraction commands:

```bash
# Claude: turn-level
jq -c 'select(.type=="result")|.usage' <claude-stream-json-output>
# Claude: per-model-call (dedupe requestId)
jq -c 'select(.type=="assistant")|{requestId,u:.message.usage}' <session-log.jsonl> | sort -u
# Codex: turn-level (cumulative)
jq -c 'select(.type=="turn.completed")|.usage' <codex-json-output>
# Codex: per-model-call
jq -c 'select(.type=="event_msg" and .payload.type=="token_count")|.payload.info.last_token_usage' <rollout.jsonl> | uniq
```
