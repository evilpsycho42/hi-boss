# Troubleshooting

## Common issues

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `error: ... connect ... daemon.sock` | Daemon not running | `hiboss daemon start --token <boss-token>` |
| You lost the agent token | Tokens are printed once | Reset local state and run `hiboss setup` again |
| Cannot send to `channel:telegram:...` | Agent not bound to Telegram | `hiboss agent set --token <boss-token> --name <agent> --bind-adapter-type telegram --bind-adapter-token <bot-token>` |
| Telegram bot doesn’t respond | Bot not bound or daemon not running | Bind the bot + ensure daemon is running |
| Messages seem “stuck” | Daemon not running, or scheduled for the future | Check daemon status/logs; verify `--deliver-at` |

## Useful commands

```bash
hiboss daemon status --token <boss-token>
hiboss agent list --token <boss-token>
```

## Logs and reset

| Item | Path |
|------|------|
| Daemon log | `~/.hiboss/daemon.log` |

Full reset (wipes local state):

```bash
hiboss daemon stop --token <boss-token>
rm -rf ~/.hiboss
hiboss setup
```
