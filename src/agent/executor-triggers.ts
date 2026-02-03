import type { EnvelopeSource } from "../envelope/source.js";

export type AgentRunTrigger =
  | { kind: "daemon-startup" }
  | { kind: "scheduler"; reason: string }
  | { kind: "envelope"; source: EnvelopeSource; envelopeId: string }
  | { kind: "reschedule" };

export function getTriggerLabel(trigger: AgentRunTrigger | undefined): string {
  if (!trigger) return "unknown";
  switch (trigger.kind) {
    case "daemon-startup":
      return "daemon-startup";
    case "scheduler":
      return `scheduler:${trigger.reason}`;
    case "envelope":
      return `envelope:${trigger.source}`;
    case "reschedule":
      return "reschedule";
  }
}

export function getTriggerFields(trigger: AgentRunTrigger | undefined): Record<string, unknown> {
  if (!trigger) return { trigger: "unknown" };
  if (trigger.kind === "envelope") {
    return { trigger: getTriggerLabel(trigger), "trigger-envelope-id": trigger.envelopeId };
  }
  return { trigger: getTriggerLabel(trigger) };
}

