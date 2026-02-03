import type { HiBossDatabase } from "../db/database.js";
import type { Envelope, CreateEnvelopeInput } from "../../envelope/types.js";
import { getEnvelopeSourceFromCreateInput } from "../../envelope/source.js";
import { parseAddress } from "../../adapters/types.js";
import type { ChatAdapter } from "../../adapters/types.js";
import { isDueUtcIso } from "../../shared/time.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { OutgoingParseMode } from "../../adapters/types.js";

export type EnvelopeHandler = (envelope: Envelope) => void | Promise<void>;

export interface MessageRouterOptions {
  onEnvelopeDone?: EnvelopeHandler;
}

/**
 * Message router for handling envelope delivery.
 */
export class MessageRouter {
  private adaptersByToken: Map<string, ChatAdapter> = new Map();
  private agentHandlers: Map<string, EnvelopeHandler> = new Map();
  private onEnvelopeDone?: EnvelopeHandler;

  constructor(private db: HiBossDatabase, options: MessageRouterOptions = {}) {
    this.onEnvelopeDone = options.onEnvelopeDone;
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

    const source = getEnvelopeSourceFromCreateInput(input);
    const fields: Record<string, unknown> = {
      "envelope-id": envelope.id,
      source,
      from: envelope.from,
      to: envelope.to,
      "deliver-at": envelope.deliverAt ?? "none",
    };

    if (source === "channel") {
      try {
        const from = parseAddress(envelope.from);
        if (from.type === "channel") {
          fields["adapter-type"] = from.adapter;
          fields["chat-id"] = from.chatId;
        }
      } catch {
        // ignore
      }

      const md = envelope.metadata;
      if (md && typeof md === "object") {
        const channelMessageId = (md as Record<string, unknown>).channelMessageId;
        if (typeof channelMessageId === "string" && channelMessageId.trim()) {
          fields["channel-message-id"] = channelMessageId.trim();
        }
      }
    }

    logEvent("info", "envelope-created", fields);

    if (isDueUtcIso(envelope.deliverAt)) {
      await this.deliverEnvelope(envelope);
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
    if (handler) {
      try {
        await handler(envelope);
      } catch (err) {
        logEvent("error", "router-deliver-to-agent-failed", {
          "envelope-id": envelope.id,
          "agent-name": agentName,
          error: errorMessage(err),
        });
      }
    } else {
      logEvent("warn", "router-no-agent-handler", {
        "envelope-id": envelope.id,
        "agent-name": agentName,
      });
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
      logEvent("error", "router-invalid-channel-sender", {
        "envelope-id": envelope.id,
        from: envelope.from,
        to: envelope.to,
      });
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

      if (this.onEnvelopeDone) {
        try {
          await this.onEnvelopeDone(envelope);
        } catch (err) {
          logEvent("error", "router-on-envelope-done-failed", {
            "envelope-id": envelope.id,
            error: errorMessage(err),
          });
        }
      }
    } catch (err) {
      const details = this.extractAdapterErrorDetails(adapterType, err);
      const msg = `Delivery to ${adapterType}:${chatId} failed: ${details.summary}`;
      logEvent("error", "channel-delivery-failed", {
        "envelope-id": envelope.id,
        "adapter-type": adapterType,
        "chat-id": chatId,
        error: details.summary,
        hint: details.hint ?? undefined,
      });
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
      logEvent("error", "envelope-metadata-update-failed", {
        "envelope-id": envelope.id,
        error: errorMessage(err),
      });
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
