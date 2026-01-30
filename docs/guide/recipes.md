# Recipes

Small, copy/paste examples.

## Scheduled reminder

```bash
hiboss envelope send --to agent:<agent-name> --token <agent-token> --text "reminder" --deliver-at +2h
```

## Monthly schedule

```bash
hiboss envelope send --to agent:<agent-name> --token <agent-token> --text "monthly" --deliver-at +1M
```

## Cron schedule (daily at 09:00)

```bash
hiboss cron create --cron "0 9 * * *" --to agent:<agent-name> --token <agent-token> --text "daily reminder"
```

Optional timezone (IANA; defaults to local):

```bash
hiboss cron create --cron "0 9 * * *" --timezone "Asia/Tokyo" --to agent:<agent-name> --token <agent-token> --text "daily reminder"
```

## Cron schedule (post to a channel)

```bash
hiboss cron create --cron "0 9 * * 1-5" --to channel:telegram:<chat-id> --token <agent-token> --text "weekday standup"
```

## Multiline text (stdin)

```bash
hiboss envelope send --to agent:<agent-name> --token <agent-token> --text - <<'EOF'
line 1
line 2
EOF
```

## Attachments

```bash
hiboss envelope send --to agent:<agent-name> --token <agent-token> --text "see attached" \
  --attachment ./report.pdf \
  --attachment ./diagram.png
```
