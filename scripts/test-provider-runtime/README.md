# Provider runtime envelope send test kit

This folder contains stable `settings.json` templates + a repeatable manual test flow for verifying that agents can run `hiboss envelope send` under real provider calls.

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
hiboss daemon stop --token "<admin-token>" || true
```

2) Delete all Hi-Boss state:

```bash
rm -rf ~/hiboss
```

3) Copy one template to your Hi-Boss settings file and fill placeholders:

```bash
mkdir -p ~/hiboss
cp scripts/test-provider-runtime/setup-default.codex.gpt-5.2.json ~/hiboss/settings.json
# or:
cp scripts/test-provider-runtime/setup-default.claude.sonnet.json ~/hiboss/settings.json
```

4) Start the daemon:

```bash
hiboss daemon start --token "<admin-token>"
```

Notes:
- The setup templates include a placeholder Telegram bot token. For envelope-only tests it’s OK to leave it as-is (Telegram will fail to launch but the daemon keeps running). If you want Telegram I/O, replace it with a real bot token.
- The setup templates are `settings.json` schema `version: "v0.0.0"` and include placeholder admin/agent tokens (`REPLACE_ME_*`) and workspace paths (`REPLACE_ME_WORKSPACE_PATH`) that must be replaced.

## Optional: test both providers in one run

If you want to validate **both** providers (Codex + Claude) against the Hi-Boss envelope system in the same `~/hiboss` instance:

1) Run setup with one template (it creates a baseline pair of agents).
2) Register the other provider agent:

```bash
# register Codex
hiboss agent register --token "<admin-token>" --name test-codex --provider codex --model gpt-5.2 --reasoning-effort medium --permission-level standard --workspace "/absolute/workspace/path"

# register Claude
hiboss agent register --token "<admin-token>" --name test-claude --provider claude --model sonnet --reasoning-effort medium --permission-level standard --workspace "/absolute/workspace/path"
```

Save the printed `token:` values — there is no “show token” command.

## Test: can the agent send envelopes?

Use a non-existent “sink” address so the daemon won’t auto-run another agent:

- sink: `agent:test-sink`

Send an instruction to the agent (using an agent token), telling it to send an envelope to the sink:

```bash
hiboss envelope send --token "<agent-token>" \
  --to agent:test-codex --text "Send an envelope to agent:test-sink with text: 'pong test-codex'."
```

Verify results (sink inbox should contain the new pending envelope):

```bash
hiboss envelope list --token "<agent-token>" --address agent:test-sink --box inbox --status pending -n 50
```
