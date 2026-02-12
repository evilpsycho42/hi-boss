# Template Variables

This document lists the context variables available to templates under `prompts/`.

Notes:
- Template language is **Nunjucks** (Jinja-like).
- Most “optional” fields are provided as empty strings or empty arrays/objects, so templates can safely do `{% if ... %}` checks.
- `auth.agentToken` is sensitive; prefer `hiboss.tokenEnvVar` guidance instead of printing the token.

---

## System Instructions (`prompts/system/base.md`)

| Variable | Type | Meaning |
|---------|------|---------|
| `hiboss.dir` | string | Hi-Boss state directory (default `~/hiboss`) |
| `hiboss.tokenEnvVar` | string | Environment variable name for the agent token (`HIBOSS_TOKEN`) |
| `hiboss.additionalContext` | string | Optional extra context appended by code (usually empty) |
| `hiboss.files.boss` | string | Contents of `{{hiboss.dir}}/BOSS.md` (or empty; legacy, not rendered in minimal system prompt) |
| `internalSpace.note` | string | Snapshot of `{{hiboss.dir}}/agents/{{agent.name}}/internal_space/MEMORY.md` (or empty) |
| `internalSpace.noteFence` | string | Markdown code fence delimiter for `internalSpace.note` (e.g., ``` or ````) |
| `internalSpace.error` | string | Internal space snapshot error message (or empty) |
| `environment.time` | string | Current time formatted in boss timezone offset (ISO 8601) |
| `environment.bossTimezone` | string | Boss timezone (IANA) used for displayed timestamps |
| `environment.daemonTimezone` | string | Daemon host timezone (IANA) used by shell commands |
| `boss.name` | string | Boss name (how agent should address the user, or empty) |
| `boss.adapterIds` | object | Boss identity per adapter type (e.g. `{ telegram: "kevin" }`, or `{}`) |
| `agent.name` | string | Agent name |
| `agent.role` | string | `speaker|leader` (required) |
| `agent.description` | string | Agent description (or empty) |
| `agent.workspace` | string | Agent workspace directory (resolved; falls back to `process.cwd()`) |
| `agent.provider` | string | `claude` or `codex` |
| `agent.model` | string | Model id/alias (or empty) |
| `agent.reasoningEffort` | string | `none|low|medium|high|xhigh` (or empty) |
| `agent.permissionLevel` | string | `restricted|standard|privileged|boss` (or empty) |
| `agent.sessionPolicy.dailyResetAt` | string | Daily reset time in `HH:MM` format (or empty) |
| `agent.sessionPolicy.idleTimeout` | string | Idle timeout duration like `2h`, `30m` (or empty) |
| `agent.sessionPolicy.maxContextLength` | number | Max context length before session refresh (or `0`) |
| `agent.createdAt` | string | ISO 8601 |
| `agent.lastSeenAt` | string | ISO 8601 (or empty) |
| `agent.metadata` | object | Agent metadata JSON blob (or `{}`) |
| `agent.files.soul` | string | Contents of `{{hiboss.dir}}/agents/{{agent.name}}/SOUL.md` (or empty; legacy, not rendered in minimal system prompt) |
| `auth.agentToken` | string | Agent token (sensitive; avoid printing) |
| `bindings` | array | Adapter bindings (no secrets) |
| `bindings[].adapterType` | string | Adapter type (e.g. `telegram`) |
| `bindings[].createdAt` | string | ISO 8601 |
| `workspace.dir` | string | Workspace directory (same as `agent.workspace`) |

---

## Turn Input (`prompts/turn/turn.md`)

| Variable | Type | Meaning |
|---------|------|---------|
| `turn.datetimeIso` | string | Current turn time formatted in boss timezone offset (ISO 8601) |
| `turn.agentName` | string | Agent name |
| `envelopes` | array | Pending envelopes for this run |
| `envelopes[].index` | number | 1-based index |
| `envelopes[].id` | string | Envelope id |
| `envelopes[].idShort` | string | Envelope id (short id; first 8 hex chars of the UUID with hyphens removed) |
| `envelopes[].from` | string | Sender address |
| `envelopes[].fromName` | string | Human-readable name: `group "<name>"` for group messages, or author name with optional `[boss]` suffix for direct messages (or empty) |
| `envelopes[].inReplyTo` | object | Present only when the channel message is a reply (or empty) |
| `envelopes[].inReplyTo.fromName` | string | Replied-to author display name (or empty) |
| `envelopes[].inReplyTo.text` | string | Replied-to text excerpt (or `(none)`) |
| `envelopes[].fromBoss` | boolean | Boss flag |
| `envelopes[].isGroup` | boolean | Whether message is from a group chat |
| `envelopes[].groupName` | string | Group name (or empty for direct/agent messages) |
| `envelopes[].authorName` | string | Author display name without boss marker (or empty) |
| `envelopes[].authorLine` | string | Author with `[boss]` suffix for group messages (or empty) |
| `envelopes[].senderLine` | string | Sender line for channel messages (e.g. `Alice (@alice) in group "hiboss-test"` or `Alice (@alice) in private chat`) (or empty) |
| `envelopes[].createdAt.iso` | string | Created-at formatted in boss timezone offset (ISO 8601) |
| `envelopes[].deliverAt.present` | boolean | Whether deliver-at is present |
| `envelopes[].deliverAt.iso` | string | Deliver-at formatted in boss timezone offset (ISO 8601) (or empty) |
| `envelopes[].cronId` | string | Cron schedule id (short id) if this envelope was created by a cron schedule (or empty) |
| `envelopes[].content.text` | string | Text content (or `(none)`) |
| `envelopes[].content.attachments` | array | Attachment objects |
| `envelopes[].content.attachments[].type` | string | `image|video|audio|file` |
| `envelopes[].content.attachments[].source` | string | Source path/URL |
| `envelopes[].content.attachments[].filename` | string | Filename (or empty) |
| `envelopes[].content.attachments[].displayName` | string | Display name (or empty) |
| `envelopes[].content.attachmentsText` | string | Pre-rendered attachment list (or `(none)`) |

---

## CLI Envelope Instructions (`prompts/envelope/instruction.md`)

| Variable | Type | Meaning |
|---------|------|---------|
| `envelope.id` | string | Envelope id |
| `envelope.idShort` | string | Envelope id (short id; first 8 hex chars of the UUID with hyphens removed) |
| `envelope.from` | string | Sender address |
| `envelope.to` | string | Destination address |
| `envelope.fromName` | string | Human-readable name: `group "<name>"` for group messages, or author name with optional `[boss]` suffix for direct messages (or empty) |
| `envelope.inReplyTo` | object | Present only when the channel message is a reply (or empty) |
| `envelope.inReplyTo.fromName` | string | Replied-to author display name (or empty) |
| `envelope.inReplyTo.text` | string | Replied-to text excerpt (or `(none)`) |
| `envelope.fromBoss` | boolean | Boss flag |
| `envelope.isGroup` | boolean | Whether message is from a group chat |
| `envelope.groupName` | string | Group name (or empty for direct/agent messages) |
| `envelope.authorName` | string | Author display name without boss marker (or empty) |
| `envelope.authorLine` | string | Author with `[boss]` suffix for group messages (or empty) |
| `envelope.senderLine` | string | Sender line for channel messages (e.g. `Alice (@alice) in group "hiboss-test"` or `Alice (@alice) in private chat`) (or empty) |
| `envelope.createdAt.iso` | string | Created-at formatted in boss timezone offset (ISO 8601) |
| `envelope.deliverAt.present` | boolean | Whether deliver-at is present |
| `envelope.deliverAt.iso` | string | Deliver-at formatted in boss timezone offset (ISO 8601) (or empty) |
| `envelope.cronId` | string | Cron schedule id (short id) if this envelope was created by a cron schedule (or empty) |
| `envelope.content.text` | string | Text content (or `(none)`) |
| `envelope.content.attachments` | array | Attachment objects |
| `envelope.content.attachmentsText` | string | Pre-rendered attachment list (or `(none)`) |
| `envelope.metadata` | object | Raw metadata JSON blob (or `{}`) |
