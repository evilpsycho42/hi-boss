# Install

## Requirements

| Item | Notes |
|------|------|
| Node.js | Use a modern Node.js (18+ recommended) |
| Telegram (optional) | Only needed if you want to chat via Telegram |

## Install (global)

```bash
npm i -g hiboss
```

## First-time setup

```bash
hiboss setup
```

During setup, Hi-Boss will create your first agent and print an **agent token**. Save it somewhere safe (it is not shown again).

## Start the daemon

```bash
hiboss daemon start
```

Debug mode (more logs):

```bash
hiboss daemon start --debug
```
