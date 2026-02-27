/**
 * Session history types — per-session JSON file schema.
 *
 * Layout:
 *   {{agentsDir}}/<agent>/internal_space/history/YYYY-MM-DD/<sessionId>.json
 */

import type { Envelope, EnvelopeOrigin, EnvelopeStatus } from "../../envelope/types.js";

export const SESSION_FILE_VERSION = 2 as const;

export interface SessionEnvelopeCreatedEvent {
  type: "envelope-created";
  timestampMs: number;
  origin: EnvelopeOrigin;
  envelope: Envelope;
}

export interface SessionEnvelopeStatusChangedEvent {
  type: "envelope-status-changed";
  timestampMs: number;
  origin: EnvelopeOrigin;
  envelopeId: string;
  fromStatus: EnvelopeStatus;
  toStatus: EnvelopeStatus;
  reason?: string;
  outcome?: string;
}

export type SessionHistoryEvent =
  | SessionEnvelopeCreatedEvent
  | SessionEnvelopeStatusChangedEvent;

export interface SessionStatusChangeInput {
  envelope: Envelope;
  fromStatus: EnvelopeStatus;
  toStatus: EnvelopeStatus;
  timestampMs: number;
  origin: EnvelopeOrigin;
  reason?: string;
  outcome?: string;
}

export interface SessionFile {
  version: typeof SESSION_FILE_VERSION;
  sessionId: string;
  agentName: string;
  startedAtMs: number;
  endedAtMs: number | null;
  events: SessionHistoryEvent[];
}
