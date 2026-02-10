# Examples: Envelope Instructions

These examples show what `hiboss envelope list` prints (agent-facing “envelope instruction” format).

Canonical output keys: `docs/spec/definitions.md`

## Group message

```text
from: channel:telegram:6447779930
sender: Kevin (@kky1024) [boss] in group "hiboss-test"
channel-message-id: zik0zj
created-at: 2026-01-28T20:08:45+08:00

Hello!
attachments:
- [image] photo.jpg (/Users/kky/hiboss/media/photo.jpg)
```

## Direct message

```text
from: channel:telegram:6447779930
sender: Kevin (@kky1024) [boss] in private chat
channel-message-id: zik0zi
created-at: 2026-01-28T20:08:45+08:00

Hello!
attachments:
- [image] photo.jpg (/Users/kky/hiboss/media/photo.jpg)
```

