# Auto-level envelope send test kit

This folder contains stable `hiboss setup default` config templates + a repeatable manual test flow for verifying that agents can send envelopes at the supported `auto-level` settings (`medium` and `high`).

Notes:
- `auto-level: low` is no longer supported because it can block access to the local Hi-Boss IPC socket (`~/.hiboss/daemon.sock`), preventing agents from using `hiboss envelope send`.
- This test makes **real** provider calls (costs money). Ensure your local Codex/Claude credentials are configured.

## Reset + setup (from scratch)

0) If you’re running from this repo, install dependencies and link the `hiboss` CLI:

```bash
npm i
npm run build && npm link
```

1) Stop the daemon (must be done **before** deleting `~/.hiboss`):

```bash
hiboss daemon stop --token "<boss-token>" || true
```

2) Delete all Hi-Boss state:

```bash
rm -rf ~/.hiboss
```

3) Run setup using one of the templates:

```bash
hiboss setup default --config scripts/test-auto-level/setup-default.codex.gpt-5.2.json
# or:
hiboss setup default --config scripts/test-auto-level/setup-default.claude.sonnet.json
```

4) Start the daemon:

```bash
hiboss daemon start --debug --token "<boss-token>"
```

Notes:
- The setup templates include a placeholder Telegram bot token. For envelope-only tests it’s OK to leave it as-is (Telegram will fail to launch but the daemon keeps running). If you want Telegram I/O, replace it with a real bot token.
- The templates configure semantic memory to use a local GGUF embedding model. Update the `memory.model-path` if you move the file.

## Create the `medium` agents

The setup config creates `test-high` (`auto-level: high`). Create a `medium` agent while the daemon is running:

```bash
# codex/gpt-5.2
hiboss agent register --token "<boss-token>" --name test-medium --provider codex --model gpt-5.2 --reasoning-effort medium --auto-level medium --permission-level standard --workspace "/Users/kky/Dev/hi-boss.test-auto-level"

# claude/sonnet (if you used the claude setup template)
hiboss agent register --token "<boss-token>" --name test-medium --provider claude --model sonnet --reasoning-effort medium --auto-level medium --permission-level standard --workspace "/Users/kky/Dev/hi-boss.test-auto-level"
```

Save the printed `token:` values — there is no “show token” command.

## Optional: test both providers in one run

If you want to validate **both** providers (Codex + Claude) against the Hi-Boss envelope system in the same `~/.hiboss` instance:

1) Run setup with the Codex template (creates `test-high` as Codex/high).
2) Register Claude agents:

```bash
hiboss agent register --token "<boss-token>" --name claude-high --provider claude --model sonnet --reasoning-effort medium --auto-level high --permission-level standard --workspace "/Users/kky/Dev/hi-boss.test-auto-level"
hiboss agent register --token "<boss-token>" --name claude-medium --provider claude --model sonnet --reasoning-effort medium --auto-level medium --permission-level standard --workspace "/Users/kky/Dev/hi-boss.test-auto-level"
```

3) Use separate sink addresses for clarity:
- Codex sink: `agent:test-sink`
- Claude sink: `agent:test-sink-claude`

Then send instructions to `agent:claude-high` / `agent:claude-medium` that tell them to send envelopes to `agent:test-sink-claude`, and verify with:

```bash
hiboss envelope list --token "<boss-token>" --address agent:test-sink-claude --box inbox --status pending -n 50
```

## Test: can `medium` + `high` send envelopes?

Use a non-existent “sink” address so the daemon won’t auto-run another agent:

- sink: `agent:test-sink`

Send a boss-marked instruction to each agent, telling it to send an envelope to the sink:

```bash
hiboss envelope send --token "<boss-token>" --from agent:test-boss --from-name "Kevin (@kky1024)" --from-boss \
  --to agent:test-medium --text "Send an envelope to agent:test-sink with text: 'pong test-medium'."

hiboss envelope send --token "<boss-token>" --from agent:test-boss --from-name "Kevin (@kky1024)" --from-boss \
  --to agent:test-high --text "Send an envelope to agent:test-sink with text: 'pong test-high'."
```

Verify results (sink inbox should contain 2 new pending envelopes if both auto-levels can run `hiboss envelope send`):

```bash
hiboss envelope list --token "<boss-token>" --address agent:test-sink --box inbox --status pending -n 50
```
