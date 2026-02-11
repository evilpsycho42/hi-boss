import * as fs from "fs";
import * as path from "path";
import type { Agent } from "../agent/types.js";
import type { AgentBinding } from "../daemon/db/database.js";
import type { Envelope, EnvelopeAttachment } from "../envelope/types.js";
import { detectAttachmentType } from "../adapters/types.js";
import { formatUnixMsAsTimeZoneOffset } from "./time.js";
import { getDaemonIanaTimeZone } from "./timezone.js";
import { HIBOSS_TOKEN_ENV } from "./env.js";
import { getAgentDir, getHiBossDir } from "../agent/home-setup.js";
import {
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_MEMORY_LONGTERM_MAX_CHARS,
  DEFAULT_MEMORY_SHORTTERM_DAYS,
  DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS,
} from "./defaults.js";
import { formatTelegramMessageIdCompact } from "./telegram-message-id.js";
import { formatShortId } from "./id-format.js";

const MAX_CUSTOM_FILE_CHARS = 10_000;

export interface HiBossCustomizationFiles {
  boss?: string;
}

export interface AgentCustomizationFiles {
  soul?: string;
}

function truncateFileContents(contents: string): string {
  if (contents.length <= MAX_CUSTOM_FILE_CHARS) return contents;
  return (
    contents.slice(0, MAX_CUSTOM_FILE_CHARS) +
    "\n\n[...truncated...]\n"
  );
}

function readOptionalFile(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    const contents = fs.readFileSync(filePath, "utf-8");
    return truncateFileContents(contents);
  } catch {
    return undefined;
  }
}

export function readHiBossCustomizationFiles(hibossDir: string): HiBossCustomizationFiles {
  const boss = readOptionalFile(path.join(hibossDir, "BOSS.md"));
  return { boss };
}

export function readAgentCustomizationFiles(params: {
  hibossDir: string;
  agentName: string;
}): AgentCustomizationFiles {
  const agentDir = getAgentDir(params.agentName, params.hibossDir);
  const soul = readOptionalFile(path.join(agentDir, "SOUL.md"));
  return { soul };
}

function displayAttachmentName(att: { source: string; filename?: string }): string | undefined {
  if (att.filename) return att.filename;

  try {
    const url = new URL(att.source);
    const base = path.posix.basename(url.pathname);
    return base || undefined;
  } catch {
    // Not a URL; treat as local path
  }

  return path.basename(att.source) || undefined;
}

function formatAttachmentsText(attachments: EnvelopeAttachment[] | undefined): string {
  if (!attachments?.length) return "(none)";

  return attachments
    .map((att) => {
      const type = detectAttachmentType(att);
      const displayName = displayAttachmentName(att);
      if (!displayName || displayName === att.source) {
        return `- [${type}] ${att.source}`;
      }
      return `- [${type}] ${displayName} (${att.source})`;
    })
    .join("\n");
}

/**
 * Metadata structure for messages from channel adapters (e.g., Telegram).
 */
interface ChannelMetadata {
  platform: string;
  channelMessageId: string;
  author: { id: string; username?: string; displayName: string };
  chat: { id: string; name?: string };
  inReplyTo?: {
    // Prefer channelMessageId, but accept legacy messageId from older stored metadata.
    channelMessageId?: string;
    messageId?: string;
    author?: { id: string; username?: string; displayName: string };
    text?: string;
  };
}

function getFromNameOverride(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const m = metadata as Record<string, unknown>;
  if (typeof m.fromName !== "string") return undefined;
  const trimmed = m.fromName.trim();
  return trimmed ? trimmed : undefined;
}

function isChannelMetadata(metadata: unknown): metadata is ChannelMetadata {
  if (typeof metadata !== "object" || metadata === null) return false;
  const m = metadata as Record<string, unknown>;
  return (
    typeof m.platform === "string" &&
    typeof m.channelMessageId === "string" &&
    typeof m.author === "object" &&
    m.author !== null &&
    typeof (m.author as Record<string, unknown>).id === "string" &&
    typeof (m.author as Record<string, unknown>).displayName === "string" &&
    typeof m.chat === "object" &&
    m.chat !== null &&
    typeof (m.chat as Record<string, unknown>).id === "string"
  );
}

function stripBossMarkerSuffix(name: string): string {
  const trimmed = name.trim();
  return trimmed.replace(/\s\[boss\]$/, "");
}

function withBossMarkerSuffix(name: string, fromBoss: boolean): string {
  const trimmed = name.trim();
  if (!fromBoss) return trimmed;
  if (!trimmed) return trimmed;
  if (trimmed.endsWith("[boss]")) return trimmed;
  return `${trimmed} [boss]`;
}

function getCronScheduleId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>).cronScheduleId;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

interface SemanticFromResult {
  fromName: string;
  isGroup: boolean;
  groupName: string;
  authorName: string;
}

function buildSemanticFrom(envelope: Envelope): SemanticFromResult | undefined {
  const metadata = envelope.metadata;
  const override = getFromNameOverride(metadata);
  if (override) {
    const authorName = stripBossMarkerSuffix(override);
    return {
      fromName: withBossMarkerSuffix(authorName, envelope.fromBoss),
      isGroup: false,
      groupName: "",
      authorName,
    };
  }
  if (!isChannelMetadata(metadata)) return undefined;

  const { author, chat } = metadata;
  const authorName = author.username
    ? `${author.displayName} (@${author.username})`
    : author.displayName;

  if (chat.name) {
    // Group message
    return {
      fromName: `group "${chat.name}"`,
      isGroup: true,
      groupName: chat.name,
      authorName,
    };
  } else {
    return {
      // Direct message - include [boss] suffix in fromName
      fromName: withBossMarkerSuffix(authorName, envelope.fromBoss),
      isGroup: false,
      groupName: "",
      authorName,
    };
  }
}

interface InReplyToPrompt {
  channelMessageId: string;
  fromName: string;
  text: string;
}

function buildInReplyTo(metadata: unknown): InReplyToPrompt | undefined {
  if (!isChannelMetadata(metadata)) return undefined;
  const inReplyTo = metadata.inReplyTo;
  if (!inReplyTo || typeof inReplyTo !== "object") return undefined;

  const rt = inReplyTo as Record<string, unknown>;
  const rawChannelMessageId =
    typeof rt.channelMessageId === "string" ? rt.channelMessageId.trim() : "";
  const rawLegacyMessageId = typeof rt.messageId === "string" ? rt.messageId.trim() : "";
  const raw = rawChannelMessageId || rawLegacyMessageId;

  const channelMessageId =
    metadata.platform === "telegram" ? formatTelegramMessageIdCompact(raw) : raw;
  if (!channelMessageId) return undefined;

  const authorRaw = rt.author;
  let fromName = "";
  if (authorRaw && typeof authorRaw === "object") {
    const a = authorRaw as Record<string, unknown>;
    const displayName = typeof a.displayName === "string" ? a.displayName : "";
    const username = typeof a.username === "string" ? a.username : "";
    fromName = username ? `${displayName} (@${username})` : displayName;
  }

  const text = typeof rt.text === "string" && rt.text.trim() ? rt.text : "(none)";

  return {
    channelMessageId,
    fromName,
    text,
  };
}

function getChannelMessageId(metadata: unknown): string {
  if (!isChannelMetadata(metadata)) return "";
  return metadata.channelMessageId;
}

export function buildSystemPromptContext(params: {
  agent: Agent;
  agentToken: string;
  bindings: AgentBinding[];
  time?: {
    bossTimezone?: string;
  };
  hibossDir?: string;
  boss?: {
    name?: string;
    adapterIds?: Record<string, string>;
  };
}): Record<string, unknown> {
  const hibossDir = params.hibossDir ?? getHiBossDir();
  const bossTimeZone = (params.time?.bossTimezone ?? "").trim() || getDaemonIanaTimeZone();
  const daemonTimeZone = getDaemonIanaTimeZone();

  const workspaceDir =
    params.agent.workspace && params.agent.workspace.trim()
      ? params.agent.workspace.trim()
      : process.cwd();

  const hibossFiles = readHiBossCustomizationFiles(hibossDir);
  const agentFiles = readAgentCustomizationFiles({ hibossDir, agentName: params.agent.name });

  return {
    environment: {
      time: formatUnixMsAsTimeZoneOffset(Date.now(), bossTimeZone),
      bossTimezone: bossTimeZone,
      daemonTimezone: daemonTimeZone,
    },
    hiboss: {
      dir: hibossDir,
      tokenEnvVar: HIBOSS_TOKEN_ENV,
      additionalContext: "",
      files: {
        boss: hibossFiles.boss ?? "",
      },
    },
    internalSpace: {
      note: "",
      noteFence: "```",
      daily: "",
      dailyFence: "```",
      error: "",
      dailyError: "",
      longtermMaxChars: DEFAULT_MEMORY_LONGTERM_MAX_CHARS,
      dailyRecentFiles: DEFAULT_MEMORY_SHORTTERM_DAYS,
      dailyPerFileMaxChars: DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS,
      dailyMaxChars: DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS * DEFAULT_MEMORY_SHORTTERM_DAYS,
    },
    boss: {
      name: params.boss?.name ?? "",
      adapterIds: params.boss?.adapterIds ?? {},
    },
    agent: {
      name: params.agent.name,
      description: params.agent.description ?? "",
      workspace: workspaceDir,
      provider: params.agent.provider ?? DEFAULT_AGENT_PROVIDER,
      model: params.agent.model ?? "",
      reasoningEffort: params.agent.reasoningEffort ?? "",
      permissionLevel: params.agent.permissionLevel ?? "",
      sessionPolicy: {
        dailyResetAt: params.agent.sessionPolicy?.dailyResetAt ?? "",
        idleTimeout: params.agent.sessionPolicy?.idleTimeout ?? "",
        maxContextLength: params.agent.sessionPolicy?.maxContextLength ?? 0,
      },
      createdAt: formatUnixMsAsTimeZoneOffset(params.agent.createdAt, bossTimeZone),
      lastSeenAt:
        typeof params.agent.lastSeenAt === "number"
          ? formatUnixMsAsTimeZoneOffset(params.agent.lastSeenAt, bossTimeZone)
          : "",
      metadata: params.agent.metadata ?? {},
      files: {
        soul: agentFiles.soul ?? "",
      },
    },
    auth: {
      agentToken: params.agentToken,
    },
    bindings: (params.bindings ?? []).map((b) => ({
      adapterType: b.adapterType,
      createdAt: formatUnixMsAsTimeZoneOffset(b.createdAt, bossTimeZone),
    })),
    workspace: {
      dir: workspaceDir,
    },
  };
}

export function buildTurnPromptContext(params: {
  agentName: string;
  datetimeMs: number;
  bossTimezone: string;
  envelopes: Envelope[];
}): Record<string, unknown> {
  const bossTimeZone = params.bossTimezone.trim() || getDaemonIanaTimeZone();
  const envelopes = (params.envelopes ?? []).map((env, idx) => {
    const semantic = buildSemanticFrom(env);
    const rawChannelMessageId = getChannelMessageId(env.metadata);
    const channelMessageId =
      isChannelMetadata(env.metadata) && env.metadata.platform === "telegram"
        ? formatTelegramMessageIdCompact(rawChannelMessageId)
        : rawChannelMessageId;
    const inReplyTo = buildInReplyTo(env.metadata);
    const attachments = (env.content.attachments ?? []).map((att) => {
      const type = detectAttachmentType(att);
      const displayName = displayAttachmentName(att) ?? "";
      return {
        type,
        source: att.source,
        filename: att.filename ?? "",
        displayName,
      };
    });

    const authorLine = semantic ? withBossMarkerSuffix(semantic.authorName, env.fromBoss) : "";
    const senderLine = (() => {
      if (!semantic) return "";
      if (!isChannelMetadata(env.metadata)) return "";
      if (semantic.isGroup) return `${authorLine} in group "${semantic.groupName}"`;
      return `${authorLine} in private chat`;
    })();

    const cronId = (() => {
      const cronScheduleId = getCronScheduleId(env.metadata);
      return cronScheduleId ? formatShortId(cronScheduleId) : "";
    })();

    const deliverAtPresent = typeof env.deliverAt === "number";
    const deliverAt = deliverAtPresent
      ? {
          present: true,
          iso: formatUnixMsAsTimeZoneOffset(env.deliverAt as number, bossTimeZone),
        }
      : { present: false, iso: "" };

    return {
      index: idx + 1,
      id: env.id,
      from: env.from,
      fromName: semantic?.fromName ?? "",
      fromBoss: env.fromBoss,
      isGroup: semantic?.isGroup ?? false,
      groupName: semantic?.groupName ?? "",
      authorName: semantic?.authorName ?? "",
      authorLine,
      senderLine,
      channelMessageId,
      inReplyTo,
      createdAt: {
        iso: formatUnixMsAsTimeZoneOffset(env.createdAt, bossTimeZone),
      },
      deliverAt,
      cronId,
      content: {
        text: env.content.text ?? "(none)",
        attachments,
        attachmentsText: formatAttachmentsText(env.content.attachments),
      },
    };
  });

  let envelopeBlockCount = 0;
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i];
    const prev = i > 0 ? envelopes[i - 1] : undefined;
    const isGroupContinuation =
      i > 0 &&
      env.isGroup &&
      prev?.isGroup &&
      prev.from === env.from;
    if (!isGroupContinuation) {
      envelopeBlockCount++;
    }
  }

  return {
    turn: {
      datetimeIso: formatUnixMsAsTimeZoneOffset(params.datetimeMs, bossTimeZone),
      agentName: params.agentName,
      envelopeCount: envelopes.length,
      envelopeBlockCount,
    },
    envelopes,
  };
}

export function buildCliEnvelopePromptContext(params: {
  envelope: Envelope;
  bossTimezone: string;
}): Record<string, unknown> {
  const env = params.envelope;
  const bossTimeZone = params.bossTimezone.trim() || getDaemonIanaTimeZone();
  const semantic = buildSemanticFrom(env);
  const rawChannelMessageId = getChannelMessageId(env.metadata);
  const channelMessageId =
    isChannelMetadata(env.metadata) && env.metadata.platform === "telegram"
      ? formatTelegramMessageIdCompact(rawChannelMessageId)
      : rawChannelMessageId;
  const inReplyTo = buildInReplyTo(env.metadata);
  const attachments = (env.content.attachments ?? []).map((att) => {
    const type = detectAttachmentType(att);
    const displayName = displayAttachmentName(att) ?? "";
    return {
      type,
      source: att.source,
      filename: att.filename ?? "",
      displayName,
    };
  });

  const deliverAtPresent = typeof env.deliverAt === "number";
  const deliverAt = deliverAtPresent
    ? {
        present: true,
        iso: formatUnixMsAsTimeZoneOffset(env.deliverAt as number, bossTimeZone),
      }
    : { present: false, iso: "" };

  const authorLine = semantic ? withBossMarkerSuffix(semantic.authorName, env.fromBoss) : "";
  const senderLine = (() => {
    if (!semantic) return "";
    if (!isChannelMetadata(env.metadata)) return "";
    if (semantic.isGroup) return `${authorLine} in group "${semantic.groupName}"`;
    return `${authorLine} in private chat`;
  })();

  const cronId = (() => {
    const cronScheduleId = getCronScheduleId(env.metadata);
    return cronScheduleId ? formatShortId(cronScheduleId) : "";
  })();

  const lastDeliveryError = (() => {
    if (!env.metadata || typeof env.metadata !== "object") return null;
    const raw = (env.metadata as Record<string, unknown>).lastDeliveryError;
    if (!raw || typeof raw !== "object") return null;

    const r = raw as Record<string, unknown>;
    const atMs = r.atMs;
    if (typeof atMs !== "number") return null;

    return {
      ...r,
      at: formatUnixMsAsTimeZoneOffset(atMs, bossTimeZone),
    };
  })();

  return {
    envelope: {
      id: env.id,
      from: env.from,
      to: env.to,
      status: env.status,
      fromName: semantic?.fromName ?? "",
      fromBoss: env.fromBoss,
      isGroup: semantic?.isGroup ?? false,
      groupName: semantic?.groupName ?? "",
      authorName: semantic?.authorName ?? "",
      authorLine,
      senderLine,
      channelMessageId,
      inReplyTo,
      createdAt: {
        iso: formatUnixMsAsTimeZoneOffset(env.createdAt, bossTimeZone),
      },
      deliverAt,
      cronId,
      content: {
        text: env.content.text ?? "(none)",
        attachments,
        attachmentsText: formatAttachmentsText(env.content.attachments),
      },
      lastDeliveryError,
      metadata: env.metadata ?? {},
    },
  };
}
