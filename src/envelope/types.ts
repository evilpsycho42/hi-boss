import type { Address } from "../adapters/types.js";

/**
 * Attachment format for envelopes.
 */
export interface EnvelopeAttachment {
  source: string;           // Local file path (for Telegram media, downloaded to ~/.hiboss/media/)
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
  replyTo?: string;           // envelope ID for threading
  deliverAt?: string;         // ISO 8601 UTC timestamp (not-before delivery)
  status: EnvelopeStatus;
  createdAt: string;          // ISO 8601
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
  replyTo?: string;
  deliverAt?: string;
  metadata?: Record<string, unknown>;
}
