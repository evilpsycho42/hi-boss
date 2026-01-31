# Install

## Requirements

| Item | Notes |
|------|------|
| Node.js | Use a modern Node.js (18+ recommended) |
| Telegram | Currently required for `hiboss setup` (Telegram is the only supported adapter today) |

## Install (global)

```bash
npm i -g hiboss
```

## First-time setup

```bash
hiboss setup
```

During setup, Hi-Boss will create your first agent and print an **agent token**. Save it somewhere safe (it is not shown again).
It also prints a **boss token** (also shown once) that you’ll use for daemon and admin commands.

## Start the daemon

```bash
hiboss daemon start --token <boss-token>
```

Debug mode (more logs):

```bash
hiboss daemon start --token <boss-token> --debug
```
