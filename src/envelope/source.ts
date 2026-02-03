import type { CreateEnvelopeInput, Envelope } from "./types.js";

export type EnvelopeSource = "channel" | "agent" | "cron";

function hasCronScheduleId(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const v = (metadata as Record<string, unknown>).cronScheduleId;
  return typeof v === "string" && v.trim().length > 0;
}

export function getEnvelopeSourceFromEnvelope(
  envelope: Pick<Envelope, "from" | "metadata">
): EnvelopeSource {
  if (String(envelope.from).startsWith("channel:")) return "channel";
  if (hasCronScheduleId(envelope.metadata)) return "cron";
  return "agent";
}

export function getEnvelopeSourceFromCreateInput(
  input: Pick<CreateEnvelopeInput, "from" | "metadata">
): EnvelopeSource {
  if (String(input.from).startsWith("channel:")) return "channel";
  if (hasCronScheduleId(input.metadata)) return "cron";
  return "agent";
}

