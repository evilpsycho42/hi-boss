import type { HiBossDatabase } from "../db/database.js";
import type { Envelope, CreateEnvelopeInput } from "../../envelope/types.js";
import { parseAddress } from "../../adapters/types.js";
import type { ChatAdapter } from "../../adapters/types.js";
import { isDueUtcIso, nowLocalIso } from "../../shared/time.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { OutgoingParseMode } from "../../adapters/types.js";

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
      const msg = `Agent '${sender.agentName}' is not bound to adapter '${adapterType}'`;
      this.recordDeliveryError(envelope, {
        kind: "no-binding",
        message: msg,
        adapterType,
        chatId,
        senderAgentName: sender.agentName,
      });
      this.throwDeliveryFailed(msg, {
        envelopeId: envelope.id,
        adapterType,
        chatId,
        senderAgentName: sender.agentName,
        reason: "no-binding",
      });
    }

    // Get the adapter by token
    const adapter = this.adaptersByToken.get(binding.adapterToken);
    if (!adapter) {
      const msg = `No adapter loaded for adapter-type '${adapterType}' (binding exists but adapter token is not loaded)`;
      this.recordDeliveryError(envelope, {
        kind: "adapter-not-loaded",
        message: msg,
        adapterType,
        chatId,
        senderAgentName: sender.agentName,
      });
      this.throwDeliveryFailed(msg, {
        envelopeId: envelope.id,
        adapterType,
        chatId,
        senderAgentName: sender.agentName,
        reason: "adapter-not-loaded",
      });
    }

    const parseMode = this.getOutgoingParseMode(envelope);
    const replyToMessageId = this.getOutgoingReplyToMessageId(envelope);

    try {
      await adapter.sendMessage(chatId, {
        text: envelope.content.text,
        attachments: envelope.content.attachments?.map((a) => ({
          source: a.source,
          filename: a.filename,
          telegramFileId: a.telegramFileId,
        })),
      }, {
        parseMode,
        replyToMessageId,
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
      const details = this.extractAdapterErrorDetails(adapterType, err);
      const msg = `Delivery to ${adapterType}:${chatId} failed: ${details.summary}`;
      this.recordDeliveryError(envelope, {
        kind: "send-failed",
        message: msg,
        adapterType,
        chatId,
        senderAgentName: sender.agentName,
        details,
      });
      this.throwDeliveryFailed(msg, {
        envelopeId: envelope.id,
        adapterType,
        chatId,
        senderAgentName: sender.agentName,
        parseMode: parseMode ?? "plain",
        replyToMessageId: replyToMessageId ?? "",
        adapterError: details,
        reason: "send-failed",
      });
    }
  }

  private getOutgoingParseMode(envelope: Envelope): OutgoingParseMode | undefined {
    const md = envelope.metadata;
    if (!md || typeof md !== "object") return undefined;
    const v = (md as Record<string, unknown>).parseMode;
    if (v === "plain" || v === "markdownv2" || v === "html") return v;
    return undefined;
  }

  private getOutgoingReplyToMessageId(envelope: Envelope): string | undefined {
    const md = envelope.metadata;
    if (!md || typeof md !== "object") return undefined;
    const v = (md as Record<string, unknown>).replyToMessageId;
    if (typeof v !== "string" || !v.trim()) return undefined;
    return v.trim();
  }

  private recordDeliveryError(envelope: Envelope, update: Record<string, unknown>): void {
    const current =
      envelope.metadata && typeof envelope.metadata === "object" ? (envelope.metadata as Record<string, unknown>) : {};
    const next = {
      ...current,
      lastDeliveryError: {
        at: new Date().toISOString(),
        ...update,
      },
    };

    try {
      this.db.updateEnvelopeMetadata(envelope.id, next);
    } catch (err) {
      console.error(`[Router] Failed to persist lastDeliveryError for envelope ${envelope.id}:`, err);
    }
  }

  private throwDeliveryFailed(message: string, data: Record<string, unknown>): never {
    const err = new Error(message) as Error & { code: number; data: unknown };
    err.code = RPC_ERRORS.DELIVERY_FAILED;
    err.data = data;
    throw err;
  }

  private extractAdapterErrorDetails(adapterType: string, err: unknown): { summary: string; hint?: string; rawMessage?: string; telegram?: { errorCode?: number; description?: string } } {
    const rawMessage = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;

    if (adapterType === "telegram" && err && typeof err === "object") {
      const maybe = err as { response?: { error_code?: number; description?: string } };
      const errorCode = maybe.response?.error_code;
      const description = maybe.response?.description;
      const descLower = typeof description === "string" ? description.toLowerCase() : "";
      const hint =
        descLower.includes("can't parse entities") || descLower.includes("can't parse entity")
          ? "Telegram parse error: try --parse-mode plain, or escape special characters for MarkdownV2/HTML."
          : undefined;
      const summaryParts: string[] = [];
      if (typeof errorCode === "number") summaryParts.push(`telegram error_code=${errorCode}`);
      if (typeof description === "string" && description.trim()) summaryParts.push(description.trim());
      const summary = summaryParts.length ? summaryParts.join(" - ") : (rawMessage ?? "unknown error");
      return {
        summary,
        hint,
        rawMessage,
        telegram: { errorCode: typeof errorCode === "number" ? errorCode : undefined, description: typeof description === "string" ? description : undefined },
      };
    }

    return { summary: rawMessage ?? "unknown error", rawMessage };
  }
}
