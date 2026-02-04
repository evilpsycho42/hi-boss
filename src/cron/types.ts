import type { Address } from "../adapters/types.js";
import type { EnvelopeAttachment, EnvelopeStatus } from "../envelope/types.js";

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
