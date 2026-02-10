# Upgrade Compatibility (Preserved Legacy Behavior)

Hi-Boss preserves a small set of legacy behaviors so an upgraded install can still **start** and continue using existing state under the same Hi-Boss directory (default `~/hiboss`, override via `HIBOSS_DIR`).

## Preserved behaviors

### Filesystem layout

- Legacy root `~/.hiboss/` (older versions) may still exist on upgraded machines. The current layout is `~/hiboss/` with internal state under `~/hiboss/.daemon/` (see `docs/guide/troubleshooting.md` for the operator migration steps).

### Internal-space memory filename

- Best-effort migration from legacy `internal_space/Note.md` to `internal_space/MEMORY.md` is preserved so internal memory continues to load after upgrade.

### Telegram message-id formats in stored metadata

- Telegram message IDs are rendered/handled in compact base36 for ergonomics.
- Best-effort handling/migration remains for older stored formats so upgraded installs don’t misinterpret reply-to IDs.

### Reply context metadata keys

- Some older stored channel metadata used `inReplyTo.messageId` instead of `inReplyTo.channelMessageId`. Hi-Boss still accepts this when building prompts so reply context doesn’t disappear after upgrade.

### Cron schedule metadata cleanup

- Older versions allowed cron schedule templates to persist reply-to metadata. Hi-Boss strips reply-to fields so upgrades don’t cause scheduled messages to “reply” unexpectedly.

## Kept placeholders (legacy, intentionally not rendered)

These files remain supported as **placeholders** but are **not rendered** in the minimal system prompt:
- `{{HIBOSS_DIR}}/BOSS.md`
- `{{HIBOSS_DIR}}/agents/<agent-name>/SOUL.md`
