# Sending Envelopes (Documentation)

## Text Input Options

**Priority:** `--text` (direct) > `--text -` (stdin) > `--text-file`

| Option | Description |
|--------|-------------|
| `--text <text>` | Direct text (requires shell escaping for special chars) |
| `--text -` | Read text from stdin (recommended for special chars) |
| `--text-file <path>` | Read text from file |

## Recommended: Heredoc for Special Characters

Avoid shell escaping issues with heredoc syntax:

```bash
hiboss envelope send --to <address> --token <token> --text - <<'EOF'
Multi-line text with special chars:
> quote
`backticks`
"quotes"
newlines preserved
EOF
```

## From File

```bash
hiboss envelope send --to {{to}} --token <token> --text-file /path/to/msg.txt
```

## Conflicts

- Cannot use `--text` and `--text-file` together
- Cannot use `--text -` and `--text-file -` together
