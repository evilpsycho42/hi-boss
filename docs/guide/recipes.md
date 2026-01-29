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
