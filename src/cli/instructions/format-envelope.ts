import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { detectAttachmentType } from "../../adapters/types.js";
import type { Envelope, EnvelopeAttachment } from "../../envelope/types.js";
import { formatUtcIsoAsLocalOffset } from "../../shared/time.js";

type TemplateCacheKey = string;

const templateCache: Map<TemplateCacheKey, string> = new Map();

/**
 * Metadata structure for messages from channel adapters (e.g., Telegram).
 */
interface ChannelMetadata {
  platform: string;
  channelMessageId: string;
  author: { id: string; username?: string; displayName: string };
  chat: { id: string; name?: string };
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

/**
 * Build a semantic "from" string using metadata when available.
 * Falls back to raw address for agent-to-agent messages.
 */
function buildSemanticFrom(envelope: Envelope): string {
  const metadata = envelope.metadata;
  if (!isChannelMetadata(metadata)) return envelope.from;

  const { author, chat } = metadata;
  const name = author.username
    ? `${author.displayName} (@${author.username})`
    : author.displayName;
  return chat.name ? `${name} in "${chat.name}"` : name;
}

/**
 * Build the header section dynamically, omitting empty optional fields.
 */
function buildHeader(envelope: Envelope): string {
  const lines: string[] = [];
  lines.push(`from: ${envelope.from}`);
  const semanticFrom = buildSemanticFrom(envelope);
  if (semanticFrom !== envelope.from) {
    lines.push(`from-name: ${semanticFrom}`);
  }
  lines.push(`from-boss: ${envelope.fromBoss ? "true" : "false"}`);
  lines.push(`created-at: ${formatUtcIsoAsLocalOffset(envelope.createdAt)}`);
  return lines.join("\n");
}

export function formatEnvelopeInstruction(envelope: Envelope): string {
  const templates = loadEnvelopeInstructionTemplates();

  const values: Record<string, string> = {
    text: envelope.content.text ?? "(none)",
    attachments: formatAttachments(envelope.content.attachments),
  };

  const renderedHeader = buildHeader(envelope);
  const renderedText = renderTemplate("envelope/text.md", templates.text, values);
  const renderedAttachments = renderTemplate(
    "envelope/attachments.md",
    templates.attachments,
    values
  );

  return [renderedHeader, renderedText, renderedAttachments].join("\n\n").trimEnd();
}

function loadEnvelopeInstructionTemplates(): { text: string; attachments: string } {
  const instructionsDir = resolveInstructionsDir();

  return {
    text: loadTemplate(instructionsDir, path.join("envelope", "text.md")),
    attachments: loadTemplate(instructionsDir, path.join("envelope", "attachments.md")),
  };
}

function resolveInstructionsDir(): string {
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = findUp(startDir, (dir) => fs.existsSync(path.join(dir, "package.json")));
  if (!repoRoot) {
    throw new Error("Unable to locate project root (package.json) to resolve prompts");
  }

  return path.join(repoRoot, "prompts");
}

function findUp(startDir: string, predicate: (dir: string) => boolean): string | null {
  let current = startDir;
  while (true) {
    if (predicate(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function loadTemplate(instructionsDir: string, relativePath: string): string {
  const fullPath = path.join(instructionsDir, relativePath);
  const cacheKey = fullPath;

  const cached = templateCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const contents = fs.readFileSync(fullPath, "utf-8").trimEnd();
  templateCache.set(cacheKey, contents);
  return contents;
}

function renderTemplate(
  templateLabel: string,
  template: string,
  values: Record<string, string>
): string {
  const placeholderRegex = /\{\{\s*([^{}]+?)\s*\}\}/g;

  const placeholders = new Set<string>();
  for (const match of template.matchAll(placeholderRegex)) {
    placeholders.add(match[1].trim());
  }

  const missing = [...placeholders].filter((key) => values[key] === undefined);
  if (missing.length > 0) {
    const missingPlaceholders = missing.map((k) => `{{${k}}}`).join(", ");
    const providedKeys = Object.keys(values).sort().join(", ") || "(none)";
    const instructionsDir = resolveInstructionsDir();

    throw new Error(
      `Missing template variables for ${templateLabel}: ${missingPlaceholders} (provided: ${providedKeys}; instructions-dir: ${instructionsDir})`
    );
  }

  return template.replace(placeholderRegex, (_match, rawKey) => {
    const key = String(rawKey).trim();
    return values[key]!;
  });
}

function formatAttachments(attachments: EnvelopeAttachment[] | undefined): string {
  if (!attachments?.length) {
    return "(none)";
  }

  return attachments
    .map((att) => {
      const type = detectAttachmentType(att);
      const name = displayAttachmentName(att);
      if (!name || name === att.source) {
        return `- [${type}] ${att.source}`;
      }
      return `- [${type}] ${name} (${att.source})`;
    })
    .join("\n");
}

function displayAttachmentName(att: EnvelopeAttachment): string | undefined {
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
