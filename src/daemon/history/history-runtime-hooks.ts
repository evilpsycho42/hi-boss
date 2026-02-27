import type {
  EnvelopeCreatedEvent,
  EnvelopeStatusChangedEvent,
  HiBossDatabase,
} from "../db/database.js";
import type { ConversationHistory } from "./conversation-history.js";

export function bindHistoryHooks(db: HiBossDatabase, history: ConversationHistory): void {
  db.setEnvelopeLifecycleHooks({
    onEnvelopeCreated: (event: EnvelopeCreatedEvent) => {
      history.appendEnvelopeCreated({
        envelope: event.envelope,
        origin: event.origin,
        timestampMs: event.timestampMs,
      });
    },
    onEnvelopeStatusChanged: (event: EnvelopeStatusChangedEvent) => {
      history.appendStatusChange({
        envelope: event.envelope,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        timestampMs: event.timestampMs,
        origin: event.origin,
        reason: event.reason,
        outcome: event.outcome,
      });
    },
  });
}
