import type { ChannelMessage } from "../../adapters/types.js";
import type { CreateEnvelopeInput } from "../../envelope/types.js";

const CHANNEL_MESSAGE_BATCH_DEBOUNCE_MS = 200;

interface PendingChannelEnvelope {
  message: ChannelMessage;
  input: CreateEnvelopeInput;
}

interface PendingChannelBatch {
  items: PendingChannelEnvelope[];
  timer: ReturnType<typeof setTimeout>;
}

export class ChannelMessageBatcher {
  private pendingBatches: Map<string, PendingChannelBatch> = new Map();

  constructor(
    private onFlush: (input: CreateEnvelopeInput, batchSize: number) => Promise<void>
  ) {}

  enqueue(message: ChannelMessage, input: CreateEnvelopeInput): void {
    const key = this.getBatchKey(input, message);
    const existing = this.pendingBatches.get(key);
    if (existing) {
      existing.items.push({ message, input });
      clearTimeout(existing.timer);
      existing.timer = this.scheduleFlush(key);
      return;
    }

    this.pendingBatches.set(key, {
      items: [{ message, input }],
      timer: this.scheduleFlush(key),
    });
  }

  private getBatchKey(input: CreateEnvelopeInput, message: ChannelMessage): string {
    return `${message.platform}:${message.chat.id}:${input.to}`;
  }

  private scheduleFlush(key: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      void this.flush(key);
    }, CHANNEL_MESSAGE_BATCH_DEBOUNCE_MS);
  }

  private async flush(key: string): Promise<void> {
    const pending = this.pendingBatches.get(key);
    if (!pending) return;
    this.pendingBatches.delete(key);

    const mergedInput = this.mergeBatch(pending.items);
    await this.onFlush(mergedInput, pending.items.length);
  }

  private mergeBatch(items: PendingChannelEnvelope[]): CreateEnvelopeInput {
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const textParts = items
      .map((item) => item.message.content.text)
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
    const attachments = items.flatMap((item) => item.input.content.attachments ?? []);
    const metadataBase = last.input.metadata && typeof last.input.metadata === "object"
      ? { ...(last.input.metadata as Record<string, unknown>) }
      : {};

    const channelMessageIds = items.map((item) => item.message.id);
    metadataBase.channelMessageId = last.message.id;
    if (channelMessageIds.length > 1) {
      metadataBase.channelMessageIds = channelMessageIds;
    }

    const userTokens = Array.from(new Set(
      items
        .map((item) => {
          const md = item.input.metadata;
          if (!md || typeof md !== "object") return "";
          const token = (md as Record<string, unknown>).userToken;
          return typeof token === "string" ? token : "";
        })
        .filter((token) => token.length > 0)
    ));
    if (userTokens.length > 1) {
      metadataBase.userTokens = userTokens;
      delete metadataBase.userToken;
    } else if (userTokens.length === 1) {
      metadataBase.userToken = userTokens[0];
    }

    const latestReply = [...items].reverse().find((item) => item.message.inReplyTo)?.message.inReplyTo;
    if (latestReply) {
      metadataBase.inReplyTo = latestReply;
    }

    const firstUser = first.message.channelUser;
    const sameUser = items.every((item) =>
      item.message.channelUser.id === firstUser.id &&
      (item.message.channelUser.username ?? "") === (firstUser.username ?? "") &&
      item.message.channelUser.displayName === firstUser.displayName
    );
    if (!sameUser) {
      metadataBase.channelUser = { id: "batched", displayName: "Multiple users" };
      metadataBase.channelUsers = items.map((item) => item.message.channelUser);
    }

    return {
      from: first.input.from,
      to: first.input.to,
      fromBoss: items.every((item) => item.input.fromBoss === true),
      content: {
        text: textParts.length > 0 ? textParts.join("\n") : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      metadata: metadataBase,
    };
  }
}
