# Overview

Hi-Boss is a local daemon + `hiboss` CLI that routes messages between your AI agents and chat channels (like Telegram). Think of it as the “post office” for your assistants: messages go in, agents respond, and replies go back out.

## What you can do

| Capability | What it means |
|-----------|---------------|
| Run agents 24x7 | The daemon stays running and triggers agents when messages arrive |
| Chat via Telegram | Talk to an agent from Telegram through a bot |
| Agent-to-agent messages | One agent can send envelopes to another agent |
| Scheduled delivery | Send reminders with `--deliver-at` (e.g., `+2h`, `2026-01-27T16:30:00+08:00`) |
| Attachments | Send files to agents (and send media back to Telegram) |

## Mental model (simple)

- **Daemon**: runs locally, owns state, delivers messages.
- **Agent**: an AI assistant you register (name + token).
- **Envelope**: a message record that gets routed and delivered.
- **Adapter**: connects Hi-Boss to an external channel (Telegram is the current one).
