# Codex CLI Reference (Third-Party)

This file is a non-canonical integration reference for the `codex` CLI.

Canonical behavior:
- `docs/spec/provider-clis.md`

Experiments:
- `docs/experiments/provider-clis/manual-experiments.md`

## Quick help

```bash
codex exec -h
codex exec resume -h
```

## Flags used by Hi-Boss

- `exec --json`
- `--skip-git-repo-check`
- `--dangerously-bypass-approvals-and-sandbox`
- `--add-dir <path>` (fresh turns only)
- `-c developer_instructions=<text>`
- `-c model_reasoning_effort="<value>"` (optional)
- `-m <model>` (optional)
- `exec resume <thread-id> <prompt>`
- `-o <file>` (background one-shot output capture)

## Output/event notes

- `codex exec --json` emits JSONL events to stdout; logs go to stderr.
- Thread id comes from the first `thread.started` event (`thread_id`).
- `turn.completed.usage` is cumulative for the session; per-turn billing uses deltas.
- Rollout log `token_count` events include:
  - `last_token_usage` (per-call)
  - `total_token_usage` (cumulative)
- `cached_input_tokens` is a subset of `input_tokens` (not additive).

## Session files

- Default provider home used by Hi-Boss: `~/.codex`
- Rollout logs (manual inspection): `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl`

## Known gotchas

- `codex exec resume` does not accept `--add-dir`.
- `codex exec resume` does not inherit `-m` from the original session; pass `-m` explicitly when needed.
