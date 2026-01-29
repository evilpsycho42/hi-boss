import type { HiBossDatabase } from "../db/database.js";
import type { Envelope, CreateEnvelopeInput } from "../../envelope/types.js";
import { parseAddress } from "../../adapters/types.js";
import type { ChatAdapter } from "../../adapters/types.js";
import { isDueUtcIso, nowLocalIso } from "../../shared/time.js";

export type EnvelopeHandler = (envelope: Envelope) => void | Promise<void>;

export interface MessageRouterOptions {
  debug?: boolean;
}

/**
 * Message router for handling envelope delivery.
 */
export class MessageRouter {
  private adaptersByToken: Map<string, ChatAdapter> = new Map();
  private agentHandlers: Map<string, EnvelopeHandler> = new Map();
  private debug: boolean;

  constructor(private db: HiBossDatabase, options: MessageRouterOptions = {}) {
    this.debug = options.debug ?? false;
  }

  /**
   * Register a chat adapter for outbound channel messages.
   */
  registerAdapter(adapter: ChatAdapter, token?: string): void {
    if (token) {
      this.adaptersByToken.set(token, adapter);
    }
  }

  /**
   * Register a handler for messages to a specific agent.
   */
  registerAgentHandler(agentName: string, handler: EnvelopeHandler): void {
    this.agentHandlers.set(agentName, handler);
  }

  /**
   * Unregister an agent handler.
   */
  unregisterAgentHandler(agentName: string): void {
    this.agentHandlers.delete(agentName);
  }

  /**
   * Route a new envelope to its destination.
   */
  async routeEnvelope(input: CreateEnvelopeInput): Promise<Envelope> {
    const envelope = this.db.createEnvelope(input);

    // Debug logging for created envelope
    if (this.debug) {
      console.log(`[${nowLocalIso()}] Envelope created:`);
      console.log(JSON.stringify(envelope, null, 2));
    }

    if (isDueUtcIso(envelope.deliverAt)) {
      await this.deliverEnvelope(envelope);
    } else if (this.debug) {
      console.log(`[${nowLocalIso()}] Envelope scheduled for future delivery:`);
      console.log(JSON.stringify({
        id: envelope.id,
        to: envelope.to,
        deliverAt: envelope.deliverAt,
        status: envelope.status,
      }, null, 2));
    }
    return envelope;
  }

  /**
   * Deliver an envelope to its destination.
   */
  async deliverEnvelope(envelope: Envelope): Promise<void> {
    const destination = parseAddress(envelope.to);

    if (destination.type === "agent") {
      await this.deliverToAgent(envelope, destination.agentName);
    } else if (destination.type === "channel") {
      await this.deliverToChannel(envelope, destination.adapter, destination.chatId);
    }
  }

  private async deliverToAgent(envelope: Envelope, agentName: string): Promise<void> {
    const handler = this.agentHandlers.get(agentName);
    if (this.debug) {
      console.log(`[${nowLocalIso()}] [Router] deliverToAgent: agent=${agentName} handler=${handler ? "found" : "NOT_FOUND"}`);
    }
    if (handler) {
      try {
        await handler(envelope);
      } catch (err) {
        console.error(`[Router] Error delivering to agent ${agentName}:`, err);
      }
    } else {
      console.warn(`[Router] No handler registered for agent ${agentName}`);
    }
    // If no handler, message stays in inbox with pending status
  }

  private async deliverToChannel(
    envelope: Envelope,
    adapterType: string,
    chatId: string
  ): Promise<void> {
    // Find the sender's agent name
    const sender = parseAddress(envelope.from);
    if (sender.type !== "agent") {
      console.error(`[Router] Cannot send to channel from non-agent address: ${envelope.from}`);
      return;
    }

    // Get the sender's binding for this adapter type
    const binding = this.db.getAgentBindingByType(sender.agentName, adapterType);
    if (!binding) {
      console.error(`[Router] Agent ${sender.agentName} has no ${adapterType} binding`);
      return;
    }

    // Get the adapter by token
    const adapter = this.adaptersByToken.get(binding.adapterToken);
    if (!adapter) {
      console.error(`[Router] No adapter found for binding token`);
      return;
    }

    try {
      await adapter.sendMessage(chatId, {
        text: envelope.content.text,
        attachments: envelope.content.attachments?.map((a) => ({
          source: a.source,
          filename: a.filename,
        })),
      });
      this.db.updateEnvelopeStatus(envelope.id, "done");
      console.log(`[${nowLocalIso()}] [Router] Delivered message to ${adapterType}:${chatId}`);

      // Debug logging for delivered envelope
      if (this.debug) {
        console.log(`[${nowLocalIso()}] Envelope delivered to channel:`);
        console.log(JSON.stringify({
          id: envelope.id,
          to: envelope.to,
          status: "done",
        }, null, 2));
      }
    } catch (err) {
      console.error(`[Router] Error delivering to channel ${adapterType}:${chatId}:`, err);
    }
  }
}
