# Token Usage

This document specifies how Hi-Boss records and interprets token usage for agent turns, and why the numbers differ between Claude and Codex.

## What Hi-Boss logs

Hi-Boss logs per-run usage from `UnifiedSession.run()` results (for successful runs):

- `context_length`: best-effort estimate of the **final model-call context length** for the turn (SDK-provided; may be missing)
- `input_tokens`: total input tokens processed for the run (including any cached tokens)
- `output_tokens`: total output tokens generated for the run
- `total_tokens`: total tokens for the run (may be omitted; Hi-Boss does not derive this when missing)
- `cache_read_tokens`: input tokens served from prompt cache (if the provider supports it)
- `cache_write_tokens`: input tokens written to prompt cache (if the provider supports it)

Important:
- `usage.*_tokens` is the unified-agent-sdk **per-turn aggregate** for the whole run (including any internal agent/tool loops and multiple model calls). The SDK normalizes provider-specific usage into this breakdown; fields may be omitted.
- `context_length` is a best-effort estimate of the **final** model-call context size, and is what Hi-Boss uses for the session refresh threshold (`--session-max-context-length` / `maxContextLength`) when present. If `context_length` is missing, the max-context-length policy is skipped for that run.

Storage:
- When available, `context_length` is persisted to `agent_runs.context_length` for operator introspection (see `docs/spec/configuration.md#agent_runs-table`).

## Provider behavior differences

### Claude (Claude Code)

- Claude Code usage reported at the end of a run can be **aggregated across multiple internal model calls** (this shows up directly in `usage`).
- `context_length` is derived from the latest streaming usage snapshot (best-effort) and is intended to reflect the final model call that produced the assistant message.

### Codex (Codex CLI)

Codex behaves differently in multi-turn sessions:

- Codex CLI injects repository and environment context (notably **`AGENTS.md` instructions** and **`<environment_context>`**) as **new user messages on every turn**.
- Those injected messages become part of the conversation history, so the effective context grows faster than “just the user prompt + assistant replies”.
- This is why, for Codex, the previous turn’s `total_tokens` is often **not close** to the next turn’s `input_tokens`: new injected messages are appended between turns.

#### How to verify (Codex)

Codex stores sessions under `~/.codex/sessions/**/rollout-*.jsonl`. In a multi-turn session, you will typically see one occurrence per turn of:

- `# AGENTS.md instructions for ...`
- `<environment_context>`

Quick sanity checks:

```bash
rg -c "# AGENTS.md instructions" ~/.codex/sessions/**/rollout-*.jsonl
rg -c "<environment_context>" ~/.codex/sessions/**/rollout-*.jsonl
```

## Comparison: real multi-turn run (12 turns)

Run config:

- `session-mode=continuous` (one session, many turns)
- `filler-words=1200` (stable instruction-file filler to encourage caching)
- `reasoningEffort=low`
- Claude: `model=haiku`
- Codex: `model=gpt-5.2`
- Generated: 2026-01-30

Repro command:

```bash
npm run verify:token-usage:real -- \
  --provider=both \
  --session-mode=continuous \
  --turns=12 \
  --filler-words=1200 \
  --claude-model=haiku \
  --codex-model=gpt-5.2 \
  --prompt "You are in a multi-turn test.\nDo not use any tools.\nReply in plain text only.\nReply exactly: OK"
```

Per-turn usage (input/output/total) and cache breakdown:

| provider | model | reasoningEffort | turn | input_tokens | output_tokens | total_tokens | cache_read_tokens | cache_write_tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | haiku | low | 1 | 16494 | 92 | 16586 | 0 | 16484 |
| claude | haiku | low | 2 | 16541 | 59 | 16600 | 13325 | 3206 |
| claude | haiku | low | 3 | 16587 | 85 | 16672 | 15295 | 1282 |
| claude | haiku | low | 4 | 16633 | 83 | 16716 | 15341 | 1282 |
| claude | haiku | low | 5 | 16679 | 61 | 16740 | 15387 | 1282 |
| claude | haiku | low | 6 | 16725 | 96 | 16821 | 15433 | 1282 |
| claude | haiku | low | 7 | 16771 | 81 | 16852 | 15479 | 1282 |
| claude | haiku | low | 8 | 16817 | 68 | 16885 | 15525 | 1282 |
| claude | haiku | low | 9 | 16863 | 81 | 16944 | 15571 | 1282 |
| claude | haiku | low | 10 | 16909 | 56 | 16965 | 15617 | 1282 |
| claude | haiku | low | 11 | 17057 | 54 | 17111 | 15663 | 1384 |
| claude | haiku | low | 12 | 17103 | 64 | 17167 | 15709 | 1384 |
| codex | gpt-5.2 | low | 1 | 13553 | 29 | 13582 | 3840 | 0 |
| codex | gpt-5.2 | low | 2 | 15786 | 5 | 15791 | 13440 | 0 |
| codex | gpt-5.2 | low | 3 | 18019 | 5 | 18024 | 15744 | 0 |
| codex | gpt-5.2 | low | 4 | 20252 | 5 | 20257 | 17920 | 0 |
| codex | gpt-5.2 | low | 5 | 22485 | 5 | 22490 | 20224 | 0 |
| codex | gpt-5.2 | low | 6 | 24718 | 5 | 24723 | 22400 | 0 |
| codex | gpt-5.2 | low | 7 | 26951 | 5 | 26956 | 24576 | 0 |
| codex | gpt-5.2 | low | 8 | 29184 | 5 | 29189 | 26880 | 0 |
| codex | gpt-5.2 | low | 9 | 31417 | 5 | 31422 | 29056 | 0 |
| codex | gpt-5.2 | low | 10 | 33650 | 5 | 33655 | 31360 | 0 |
| codex | gpt-5.2 | low | 11 | 35883 | 5 | 35888 | 33536 | 0 |
| codex | gpt-5.2 | low | 12 | 38116 | 5 | 38121 | 35840 | 0 |

Notes:

- The Codex per-turn prompt was intentionally tiny, but `input_tokens` still grows quickly because Codex injects repo/environment context every turn and it accumulates in the thread history.
