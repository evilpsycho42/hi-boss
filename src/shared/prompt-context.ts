import * as fs from "fs";
import * as path from "path";
import type { Agent } from "../agent/types.js";
import type { AgentBinding } from "../daemon/db/database.js";
import type { Envelope, EnvelopeAttachment } from "../envelope/types.js";
import { detectAttachmentType } from "../adapters/types.js";
import { formatUtcIsoAsLocalOffset } from "./time.js";
import { HIBOSS_TOKEN_ENV } from "./env.js";
import { getAgentDir, getHiBossDir } from "../agent/home-setup.js";

const MAX_CUSTOM_FILE_CHARS = 10_000;

export interface HiBossCustomizationFiles {
  user?: string;
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
  const user = readOptionalFile(path.join(hibossDir, "USER.md"));
  return { user };
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

function buildSemanticFrom(envelope: Envelope): string | undefined {
  const metadata = envelope.metadata;
  const override = getFromNameOverride(metadata);
  if (override) return override;
  if (!isChannelMetadata(metadata)) return undefined;

  const { author, chat } = metadata;
  const name = author.username
    ? `${author.displayName} (@${author.username})`
    : author.displayName;
  return chat.name ? `${name} in "${chat.name}"` : name;
}

export function buildSystemPromptContext(params: {
  agent: Agent;
  agentToken: string;
  bindings: AgentBinding[];
  hibossDir?: string;
}): Record<string, unknown> {
  const hibossDir = params.hibossDir ?? getHiBossDir();

  const workspaceDir =
    params.agent.workspace && params.agent.workspace.trim()
      ? params.agent.workspace.trim()
      : process.cwd();

  const hibossFiles = readHiBossCustomizationFiles(hibossDir);
  const agentFiles = readAgentCustomizationFiles({ hibossDir, agentName: params.agent.name });

  return {
    hiboss: {
      dir: hibossDir,
      tokenEnvVar: HIBOSS_TOKEN_ENV,
      additionalContext: "",
      files: {
        user: hibossFiles.user ?? "",
      },
    },
    agent: {
      name: params.agent.name,
      description: params.agent.description ?? "",
      workspace: workspaceDir,
      provider: params.agent.provider ?? "claude",
      model: params.agent.model ?? "",
      reasoningEffort: params.agent.reasoningEffort ?? "",
      autoLevel: params.agent.autoLevel ?? "",
      createdAt: params.agent.createdAt,
      lastSeenAt: params.agent.lastSeenAt ?? "",
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
      createdAt: b.createdAt,
    })),
    workspace: {
      dir: workspaceDir,
    },
  };
}

export function buildTurnPromptContext(params: {
  agentName: string;
  datetimeIso: string;
  envelopes: Envelope[];
}): Record<string, unknown> {
  const envelopes = (params.envelopes ?? []).map((env, idx) => {
    const semanticFrom = buildSemanticFrom(env) ?? "";
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

    return {
      index: idx + 1,
      id: env.id,
      from: env.from,
      fromName: semanticFrom,
      fromBoss: env.fromBoss,
      createdAt: {
        utcIso: env.createdAt,
        localIso: formatUtcIsoAsLocalOffset(env.createdAt),
      },
      content: {
        text: env.content.text ?? "(none)",
        attachments,
        attachmentsText: formatAttachmentsText(env.content.attachments),
      },
    };
  });

  return {
    turn: {
      datetimeIso: params.datetimeIso,
      agentName: params.agentName,
    },
    envelopes,
  };
}

export function buildCliEnvelopePromptContext(params: {
  envelope: Envelope;
}): Record<string, unknown> {
  const env = params.envelope;
  const semanticFrom = buildSemanticFrom(env) ?? "";
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

  const deliverAt =
    env.deliverAt && env.deliverAt.trim()
      ? {
          utcIso: env.deliverAt,
          localIso: formatUtcIsoAsLocalOffset(env.deliverAt),
        }
      : { utcIso: "", localIso: "" };

  return {
    envelope: {
      id: env.id,
      from: env.from,
      to: env.to,
      fromName: semanticFrom,
      fromBoss: env.fromBoss,
      createdAt: {
        utcIso: env.createdAt,
        localIso: formatUtcIsoAsLocalOffset(env.createdAt),
      },
      deliverAt,
      content: {
        text: env.content.text ?? "(none)",
        attachments,
        attachmentsText: formatAttachmentsText(env.content.attachments),
      },
      metadata: env.metadata ?? {},
    },
  };
}
