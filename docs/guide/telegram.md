# Telegram

Hi-Boss can connect an agent to Telegram via a bot.

## How it works (diagram)

```
Telegram user  ->  Telegram bot  ->  Hi-Boss daemon  ->  agent
agent reply    ->  Hi-Boss daemon ->  Telegram bot   ->  Telegram user
```

## 1) Create a Telegram bot token

Use Telegram’s @BotFather to create a bot and copy the bot token.

## 2) Bind the bot to an agent

```bash
hiboss agent bind --name <agent-name> --adapter-type telegram --adapter-token <telegram-bot-token>
```

## 3) Talk to your agent

Send a message to your bot in Telegram. Hi-Boss will route it to the bound agent.

To reply to a chat from the CLI, use the `from:` address shown by:

```bash
hiboss envelope list --token <agent-token> --box inbox --status pending -n 10
```

You’ll see an address like:

```
from: channel:telegram:<chat-id>
```

Use it as the destination when sending:

```bash
hiboss envelope send --to channel:telegram:<chat-id> --token <agent-token> --text "got it"
```

## Refresh session (`/new`)

Send `/new` to the bot to request a session refresh.
