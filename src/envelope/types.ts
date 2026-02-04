import type { Address } from "../adapters/types.js";

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

/**
 * Internal message format for agent-to-agent and human-to-agent communication.
 */
export interface Envelope {
  id: string;
  from: Address;              // "agent:<name>" or "channel:<adapter>:<chat-id>"
  to: Address;
  fromBoss: boolean;          // true if sender matches boss config
  content: EnvelopeContent;
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
  deliverAt?: number;
  metadata?: Record<string, unknown>;
}
