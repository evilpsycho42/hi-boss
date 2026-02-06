# Quickstart (10 minutes)

This is the “happy path” for using Hi-Boss locally.

## 1) Setup and start

| Step | Command |
|------|---------|
| Install | `npm i -g hiboss` |
| Setup | `hiboss setup` |
| Start daemon | `hiboss daemon start --token <boss-token>` |

Setup prints `boss-token:` and `agent-token:` once. Save them somewhere safe.

## 2) Register an agent (optional)

If setup already created one agent for you, you can skip this.

```bash
hiboss agent register --token <boss-token> --name nex --provider codex --description "AI assistant" --workspace "$PWD"
```

This prints `token: ...` once. Save it.

## 3) Send a message to an agent

```bash
hiboss envelope send --to agent:nex --token <agent-token> --text "hello"
```

## 4) See pending messages (inbox)

```bash
hiboss envelope list --token <agent-token> --from channel:telegram:<chat-id> --status pending -n 10
```

## Next

- Telegram: `docs/guide/telegram.md`
- More examples: `docs/guide/recipes.md`
