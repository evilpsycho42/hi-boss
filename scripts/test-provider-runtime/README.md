# Provider runtime envelope send test kit

This folder contains stable `hiboss setup --config-file ...` templates + a repeatable manual test flow for verifying that agents can run `hiboss envelope send` under real provider calls.

Notes:
- This test makes **real** provider calls (costs money). Ensure your local Codex/Claude credentials are configured.

## Reset + setup (from scratch)

0) If you’re running from this repo, install dependencies and link the `hiboss` CLI:

```bash
npm i
npm run build && npm link
```

1) Stop the daemon (must be done **before** deleting `~/hiboss`):

```bash
hiboss daemon stop --token "<boss-token>" || true
```

2) Delete all Hi-Boss state:

```bash
rm -rf ~/hiboss
```

3) Run setup using one of the templates (pass the desired boss token via `--token`):

```bash
hiboss setup --config-file scripts/test-provider-runtime/setup-default.codex.gpt-5.2.json --token "<boss-token>"
# or:
hiboss setup --config-file scripts/test-provider-runtime/setup-default.claude.sonnet.json --token "<boss-token>"
```

4) Start the daemon:

```bash
hiboss daemon start --token "<boss-token>"
```

Notes:
- The setup templates include a placeholder Telegram bot token. For envelope-only tests it’s OK to leave it as-is (Telegram will fail to launch but the daemon keeps running). If you want Telegram I/O, replace it with a real bot token.
- The setup templates are config schema `version: 2` and intentionally do not include boss/agent tokens.

## Optional: test both providers in one run

If you want to validate **both** providers (Codex + Claude) against the Hi-Boss envelope system in the same `~/hiboss` instance:

1) Run setup with one template (it creates a speaker + leader baseline).
2) Register the other provider agent:

```bash
# register Codex
hiboss agent register --token "<boss-token>" --name test-codex --provider codex --model gpt-5.2 --reasoning-effort medium --permission-level standard --workspace "/Users/kky/Dev/hi-boss.test-provider-runtime"

# register Claude
hiboss agent register --token "<boss-token>" --name test-claude --provider claude --model sonnet --reasoning-effort medium --permission-level standard --workspace "/Users/kky/Dev/hi-boss.test-provider-runtime"
```

Save the printed `token:` values — there is no “show token” command.

## Test: can the agent send envelopes?

Use a non-existent “sink” address so the daemon won’t auto-run another agent:

- sink: `agent:test-sink`

Send a boss-marked instruction to the agent, telling it to send an envelope to the sink:

```bash
hiboss envelope send --token "<boss-token>" --from agent:test-boss --from-name "Kevin (@kky1024)" --from-boss \
  --to agent:test-codex --text "Send an envelope to agent:test-sink with text: 'pong test-codex'."
```

Verify results (sink inbox should contain the new pending envelope):

```bash
hiboss envelope list --token "<boss-token>" --address agent:test-sink --box inbox --status pending -n 50
```
