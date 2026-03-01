import type { Address } from "../adapters/types.js";

/**
 * One-shot execution mode for envelopes.
 *
 * - `"clone"`:    Clone current session context, execute once, discard clone.
 * - `"isolated"`: Fresh session with full agent identity, no history.
 */
export type OneshotType = "clone" | "isolated";

/**
 * Attachment format for envelopes.
 */
export interface EnvelopeAttachment {
  source: string;           // Local file path (for Telegram media, downloaded to ~/hiboss/media/)
  filename?: string;        // Helps with type detection and display
  telegramFileId?: string;  // Preserved for efficient re-sending via Telegram API
}

/**
 * Envelope content structure.
 */
export interface EnvelopeContent {
  text?: string;
  attachments?: EnvelopeAttachment[];
}

/**
 * Envelope status.
 */
export type EnvelopeStatus = "pending" | "done";
export type EnvelopeOrigin = "cli" | "channel" | "cron" | "internal";

/**
 * Internal message format for agent-to-agent and human-to-agent communication.
 */
export interface Envelope {
  id: string;
  from: Address;              // "agent:<name>" or "channel:<adapter>:<chat-id>"
  to: Address;
  fromBoss: boolean;          // true if sender resolved to role "boss"
  content: EnvelopeContent;
  priority?: number;          // 0=normal, 1=interrupt-now (higher first for agent queues)
  deliverAt?: number;         // unix epoch ms (UTC) (not-before delivery)
  status: EnvelopeStatus;
  createdAt: number;          // unix epoch ms (UTC)
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating a new envelope.
 */
export interface CreateEnvelopeInput {
  from: Address;
  to: Address;
  fromBoss?: boolean;
  content: EnvelopeContent;
  priority?: number;
  deliverAt?: number;
  metadata?: Record<string, unknown>;
}
