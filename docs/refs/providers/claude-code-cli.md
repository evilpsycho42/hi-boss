# Claude Code CLI Reference (Third-Party)

This file is a non-canonical integration reference for the `claude` CLI.

Canonical behavior:
- `docs/spec/provider-clis.md`

Experiments:
- `docs/experiments/provider-clis/manual-experiments.md`

## Quick help

```bash
claude -h
```

## Flags used by Hi-Boss

- `-p`
- `--append-system-prompt <text>`
- `--output-format stream-json` (foreground turns)
- `--output-format text` (background one-shot)
- `--verbose` (foreground turns)
- `--permission-mode bypassPermissions`
- `--add-dir <path>`
- `--model <model>` (optional)
- `-r <session-id>` (resume)

## Output/event notes

- Prefer `--output-format stream-json` for machine parsing.
- Session id comes from the JSON output as `session_id`.
- Token accounting helpers:
  - final model-call context from the last `type:"assistant"` `message.usage`
  - turn aggregate usage from `type:"result"` `usage`

## Session files

- Default provider home used by Hi-Boss: `~/.claude`
- Session logs (manual inspection): `~/.claude/projects/<project-slug>/<session_id>.jsonl`

## Known gotcha

- `--allowedTools` / `--disallowedTools` are variadic and can accidentally consume the prompt argument. Prefer stdin or `--` for manual testing.
