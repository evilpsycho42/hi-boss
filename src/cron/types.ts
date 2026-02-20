import type { Address } from "../adapters/types.js";
import type { EnvelopeAttachment, EnvelopeStatus } from "../envelope/types.js";

/**
 * Cron execution mode.
 *
 * - `"isolated"`: One-shot with fresh session context (default for new schedules via CLI).
 * - `"clone"`:    One-shot with cloned current session context.
 * - `"inline"`:   Enter the main session queue (fallback for legacy schedules without executionMode metadata).
 */
export type CronExecutionMode = "isolated" | "clone" | "inline";

const VALID_EXECUTION_MODES: ReadonlySet<string> = new Set(["isolated", "clone", "inline"]);

/**
 * Extract execution mode from schedule metadata, defaulting to "inline"
 * for backward compatibility with schedules created before execution modes existed.
 */
export function getCronExecutionMode(metadata?: Record<string, unknown>): CronExecutionMode {
  if (!metadata) return "inline";
  const raw = metadata.executionMode;
  if (typeof raw === "string" && VALID_EXECUTION_MODES.has(raw)) {
    return raw as CronExecutionMode;
  }
  return "inline";
}

export interface CronSchedule {
  id: string;
  agentName: string; // owner/sender agent
  cron: string;
  timezone?: string; // IANA timezone; missing means inherit boss timezone
  enabled: boolean;
  to: Address;
  content: {
    text?: string;
    attachments?: EnvelopeAttachment[];
  };
  metadata?: Record<string, unknown>;
  pendingEnvelopeId?: string;
  pendingEnvelopeStatus?: EnvelopeStatus;
  nextDeliverAt?: number; // unix epoch ms (UTC) for the pending envelope (if any)
  createdAt: number;      // unix epoch ms (UTC)
  updatedAt?: number;     // unix epoch ms (UTC)
}

export interface CreateCronScheduleInput {
  agentName: string;
  cron: string;
  timezone?: string;
  enabled?: boolean;
  to: Address;
  content: {
    text?: string;
    attachments?: EnvelopeAttachment[];
  };
  metadata?: Record<string, unknown>;
}
