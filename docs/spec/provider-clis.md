# Provider CLIs (Claude Code + Codex CLI)

This document specifies how Hi-Boss invokes provider CLIs:

- Claude Code CLI (`claude`)
- Codex CLI (`codex exec`)

It is focused on **current Hi-Boss behavior**. Manual experiments and CLI gotchas are recorded in:
- `docs/spec/appendix/provider-clis-experiments.md`

Key implementation files:
- `src/agent/executor-turn.ts` (process spawning + args)
- `src/agent/provider-cli-parsers.ts` (JSONL parsing)
- `src/agent/session-resume.ts` / `src/agent/persisted-session.ts` (resume handles)

## Provider homes (shared, forced)

Provider state is shared across all agents (no per-agent provider homes). Hi-Boss always uses the user’s default homes:
- Claude: `~/.claude`
- Codex: `~/.codex`

To keep behavior stable, Hi-Boss clears provider-home override env vars when spawning provider processes:
- clears `CLAUDE_CONFIG_DIR`
- clears `CODEX_HOME`

## System instructions injection

- Claude: `--append-system-prompt <text>` (appends Hi-Boss system instructions)
- Codex: `-c developer_instructions=<text>` (sets developer instructions)

## Runtime controls (canonical)

Hi-Boss runs provider CLIs in **full-access mode** so agents can reliably execute `hiboss` commands.

- Codex: always passes `--dangerously-bypass-approvals-and-sandbox` (fresh + resume).
- Claude: always passes `--permission-mode bypassPermissions`.

## Invocation (canonical)

Claude (per turn):
- `claude -p --append-system-prompt ... --output-format stream-json --verbose --permission-mode bypassPermissions`
- Adds `--add-dir` for:
  - `{{HIBOSS_DIR}}/agents/<agent>/internal_space`
- Adds `--model <model>` when configured.
- Adds `-r <session-id>` when resuming.

Codex (per turn):
- Fresh: `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --add-dir ... -c developer_instructions=... [-c model_reasoning_effort=\"...\"] [-m <model>] <prompt>`
- Resume: `codex exec resume --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [-c ...] [-m <model>] <thread-id> <prompt>`
  - Note: `codex exec resume` does not support `--add-dir`.

## Abort / cancellation behavior

Provider CLIs can be aborted by terminating the child process (SIGINT/SIGTERM). Expect partial output; do not assume a final “success result” JSON event.

## Token usage

### Hi-Boss metrics

A single Hi-Boss "turn" (one `codex exec` or `claude -p` invocation) can trigger **multiple model calls** (tool loops). Hi-Boss computes two kinds of metrics:

| Metric | Meaning | Logged | Persisted |
|---|---|---|---|
| `context-length` | Final model-call size (prompt + output of the **last** API request in the turn) | Always | `agent_runs.context_length` |
| `input-tokens` | Total input tokens consumed in the turn (billing) | Debug only | No |
| `output-tokens` | Total output tokens consumed in the turn (billing) | Debug only | No |
| `cache-read-tokens` | Cache hits (prompt tokens served from cache) | Debug only | No |
| `cache-write-tokens` | Cache writes (new prompt tokens written to cache) | Debug only | No |
| `total-tokens` | `input-tokens + output-tokens` | Debug only | No |

- All metrics are logged on the `agent-run-complete` event. Debug-only fields require `hiboss daemon start --debug`.
- `context-length` drives the `session-max-context-length` refresh policy. If missing (`null`), the policy check is skipped.
- On failure/cancellation, `context-length` is cleared to `NULL`.

### Calculation: Claude

Source: `--output-format stream-json` JSONL.

**`context-length`** — from the **last `type:"assistant"` event's `message.usage`**:

```
context-length = input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens
```

All four fields are needed because Claude reports `input_tokens` as only the uncached portion; cached tokens are separate.

**Billing fields** — from the aggregated `result.usage` (summed across all model calls in the turn):

```
input-tokens       = result.usage.input_tokens
output-tokens      = result.usage.output_tokens
cache-read-tokens  = result.usage.cache_read_input_tokens
cache-write-tokens = result.usage.cache_creation_input_tokens
total-tokens       = input-tokens + output-tokens
```

### Calculation: Codex

**`context-length`** — from the rollout log on disk (best-effort enrichment):

```
# File: ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl
# Event: last event_msg with payload.type="token_count"

context-length = last_token_usage.input_tokens + last_token_usage.output_tokens
```

`cached_input_tokens` is a breakdown **within** `input_tokens` (not additive).

**Billing fields** — per-turn deltas from cumulative `turn.completed.usage`:

```
input-tokens      = current.input_tokens      - previous.input_tokens
output-tokens     = current.output_tokens      - previous.output_tokens
cache-read-tokens = current.cached_input_tokens - previous.cached_input_tokens
cache-write-tokens = null  (Codex does not report this)
total-tokens      = input-tokens + output-tokens
```

Hi-Boss persists the last-seen cumulative totals in `agents.metadata.sessionHandle` (`codexCumulativeUsage`). If prior totals are missing (first run or upgrade while resuming), billing fields are `null` for that run.

### Session files (for manual inspection)

| Provider | File | Key fields |
|---|---|---|
| Claude | `~/.claude/projects/<project-slug>/<session_id>.jsonl` | `type:"assistant"` entries with `requestId` and `message.usage`; deduplicate by `requestId` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-...<thread_id>.jsonl` | `event_msg` with `payload.type="token_count"` → `last_token_usage` (per-call) and `total_token_usage` (cumulative); also reports `model_context_window` |

## Appendix

- Manual experiments + CLI gotchas: `docs/spec/appendix/provider-clis-experiments.md`
