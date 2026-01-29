/**
 * Turn input builder for agent runs.
 *
 * Builds the input text for a single agent turn, combining context and pending envelopes.
 */

import type { Envelope } from "../envelope/types.js";
import { formatUtcIsoAsLocalOffset } from "../shared/time.js";
import {
  loadTemplate,
  renderTemplate,
  renderAttachments,
} from "./template-renderer.js";

/**
 * Context for the current turn.
 */
export interface TurnContext {
  datetime: string;  // ISO 8601
  agentName: string;
}

/**
 * Input for building turn text.
 */
export interface TurnInput {
  context: TurnContext;
  envelopes: Envelope[];  // oldest N pending envelopes
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
 * Format a single envelope for the turn input.
 */
function formatEnvelope(envelope: Envelope, index: number): string {
  const lines: string[] = [];

  lines.push(`### Envelope ${index + 1}`);
  lines.push("");
  lines.push(`from: ${envelope.from}`);
  const semanticFrom = buildSemanticFrom(envelope);
  if (semanticFrom !== envelope.from) {
    lines.push(`from-name: ${semanticFrom}`);
  }
  lines.push(`from-boss: ${envelope.fromBoss}`);
  lines.push(`created-at: ${formatUtcIsoAsLocalOffset(envelope.createdAt)}`);
  lines.push("");

  // Text content
  lines.push("text:");
  lines.push(envelope.content.text ?? "(none)");
  lines.push("");

  // Attachments
  const attachmentsText = renderAttachments(envelope.content.attachments);
  lines.push("attachments:");
  lines.push(attachmentsText);

  return lines.join("\n");
}

/**
 * Build the full turn input text.
 *
 * Output format:
 * ```
 * ## Turn Context
 * datetime: 2026-01-27T12:00:00Z
 * agent: nex
 *
 * ## Pending Envelopes (3)
 *
 * ### Envelope 1
 * id: abc-123
 * from: channel:telegram:12345
 * ...
 *
 * ---
 *
 * ### Envelope 2
 * ...
 * ```
 *
 * @param turnInput - Turn context and envelopes
 * @returns Formatted turn input text
 */
export function buildTurnInput(turnInput: TurnInput): string {
  const { context, envelopes } = turnInput;
  const lines: string[] = [];

  // Turn context section
  try {
    const contextTemplate = loadTemplate("turn/context");
    const contextText = renderTemplate(contextTemplate, {
      datetime: context.datetime,
      agent: context.agentName,
    });
    lines.push(contextText);
  } catch (error) {
    // Fall back to inline format only if template doesn't exist
    if (error instanceof Error && error.message.startsWith("Template not found:")) {
      lines.push("## Turn Context");
      lines.push("");
      lines.push(`datetime: ${context.datetime}`);
      lines.push(`agent: ${context.agentName}`);
    } else {
      throw error;
    }
  }

  lines.push("");

  // Pending envelopes section
  if (envelopes.length === 0) {
    lines.push("## Pending Envelopes (0)");
    lines.push("");
    lines.push("No pending envelopes.");
  } else {
    lines.push(`## Pending Envelopes (${envelopes.length})`);
    lines.push("");

    for (let i = 0; i < envelopes.length; i++) {
      lines.push(formatEnvelope(envelopes[i], i));

      // Add separator between envelopes
      if (i < envelopes.length - 1) {
        lines.push("");
        lines.push("---");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

/**
 * Format a single envelope as a prompt (for single-envelope runs).
 *
 * @param envelope - The envelope to format
 * @returns Formatted envelope text
 */
export function formatEnvelopeAsPrompt(envelope: Envelope): string {
  return formatEnvelope(envelope, 0);
}
