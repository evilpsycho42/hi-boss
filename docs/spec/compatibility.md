# Upgrade Compatibility (Preserved Legacy Behavior)

Hi-Boss preserves a small set of legacy behaviors so an upgraded install can still **start** and continue using existing state under the same Hi-Boss directory (default `~/hiboss`, override via `HIBOSS_DIR`).

## Preserved behaviors

### Filesystem layout

- Legacy root `~/.hiboss/` (older versions) may still exist on upgraded machines. The current layout is `~/hiboss/` with internal state under `~/hiboss/.daemon/`. For operator migration, move state from `~/.hiboss/` to `~/hiboss/` before starting the daemon.

### Internal-space memory filename

- Best-effort migration from legacy `internal_space/Note.md` to `internal_space/MEMORY.md` is preserved so internal memory continues to load after upgrade.

### Legacy outgoing reply-id metadata (`replyToMessageId`)

- Some older stored envelopes may contain `metadata.replyToMessageId`.
- Runtime no longer uses this field for outbound channel quoting.
- Canonical outbound quoting uses `metadata.replyToEnvelopeId` linkage only.
- If only legacy `replyToMessageId` exists, delivery still succeeds but sends without quote/reply context.

### Reply context metadata keys

- Some older stored channel metadata used `inReplyTo.messageId` instead of `inReplyTo.channelMessageId`. Hi-Boss still accepts this when building prompts so reply context doesn’t disappear after upgrade.

### Cron schedule metadata cleanup

- Older versions allowed cron schedule templates to persist reply-to metadata. Hi-Boss strips reply-to fields so upgrades don’t cause scheduled messages to “reply” unexpectedly.

## Kept placeholders (legacy, intentionally not rendered)

These files remain supported as **placeholders** but are **not rendered** in the minimal system prompt:
- `{{HIBOSS_DIR}}/BOSS.md`
- `{{HIBOSS_DIR}}/agents/<agent-name>/SOUL.md`
