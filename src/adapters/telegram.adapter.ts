import { Telegraf } from "telegraf";
import * as fs from "fs";
import * as path from "path";
import type { ChatAdapter, MessageContent, ChannelMessageHandler, Attachment, ChannelCommandHandler, ChannelCommand, OutgoingParseMode, SendMessageOptions } from "./types.js";
import { detectAttachmentType } from "./types.js";
import { getDefaultMediaDir } from "../shared/defaults.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import { parseTelegramMessageId } from "../shared/telegram-message-id.js";
import { buildTelegramChannelMessage, type MessageContext } from "./telegram-inbound.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGetUpdatesConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const typed = err as { response?: { error_code?: number; description?: string } };
  if (typed.response?.error_code !== 409) return false;
  return typed.response?.description?.toLowerCase().includes("getupdates") ?? false;
}

function computeBackoff(attempt: number): number {
  const initialMs = 2000;
  const maxMs = 30000;
  const factor = 1.8;
  const jitter = 0.25;

  const base = Math.min(initialMs * Math.pow(factor, attempt), maxMs);
  const variance = base * jitter * (Math.random() * 2 - 1);
  return Math.round(base + variance);
}

function toTelegramParseMode(mode: OutgoingParseMode | undefined): "MarkdownV2" | "HTML" | undefined {
  switch (mode) {
    case "markdownv2":
      return "MarkdownV2";
    case "html":
      return "HTML";
    case "plain":
    case undefined:
      return undefined;
  }
}

/**
 * Telegram adapter for the chat bot.
 *
 * Limitations:
 * - Media groups (albums): When users send multiple images/videos together,
 *   Telegram delivers each as a separate message. Only the first message
 *   contains the caption. These messages share a `media_group_id` in the raw
 *   payload but are currently emitted as independent messages.
 */
export class TelegramAdapter implements ChatAdapter {
  readonly platform = "telegram";
  private bot: Telegraf;
  private handlers: ChannelMessageHandler[] = [];
  private commandHandlers: ChannelCommandHandler[] = [];
  private mediaDir: string;
  private stopped = false;
  private started = false;

  constructor(token: string) {
    this.bot = new Telegraf(token);
    this.mediaDir = getDefaultMediaDir();
    this.setupListeners();
  }

  private setupListeners(): void {
    // Handle /new command
    this.bot.command("new", async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const username = ctx.from?.username;

      const command: ChannelCommand = {
        command: "new",
        args: ctx.message.text.replace(/^\/new\s*/, ""),
        chatId,
        authorUsername: username,
      };

      for (const handler of this.commandHandlers) {
        await handler(command);
      }

      // Acknowledge the command
      await ctx.reply("Session refresh requested.");
    });

    this.bot.on("text", (ctx) => this.handleMessage(ctx));
    this.bot.on("photo", (ctx) => this.handleMessage(ctx));
    this.bot.on("video", (ctx) => this.handleMessage(ctx));
    this.bot.on("document", (ctx) => this.handleMessage(ctx));
    this.bot.on("voice", (ctx) => this.handleMessage(ctx));
    this.bot.on("audio", (ctx) => this.handleMessage(ctx));
  }

  private async handleMessage(ctx: MessageContext): Promise<void> {
    const message = await buildTelegramChannelMessage({
      ctx,
      bot: this.bot,
      platform: this.platform,
      mediaDir: this.mediaDir,
    });

    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  async sendMessage(chatId: string, content: MessageContent, options: SendMessageOptions = {}): Promise<void> {
    const { text, attachments } = content;
    const telegramParseMode = toTelegramParseMode(options.parseMode);

    const replyParameters =
      options.replyToMessageId && options.replyToMessageId.trim()
        ? {
            message_id: parseTelegramMessageId(
              options.replyToMessageId,
              "reply-to-channel-message-id"
            ),
          }
        : undefined;

    // Prefer native albums when possible (Telegram sendMediaGroup)
    if (attachments && attachments.length >= 2) {
      const types = attachments.map((a) => detectAttachmentType(a));
      const allMedia = types.every((t) => t === "image" || t === "video");
      const allDocuments = types.every((t) => t === "file");
      const allAudios = types.every((t) => t === "audio");

      const canSendMediaGroup = allMedia || allDocuments || allAudios;
      if (canSendMediaGroup) {
        const chunks: Attachment[][] = [];
        for (let i = 0; i < attachments.length; i += 10) {
          chunks.push(attachments.slice(i, i + 10));
        }

        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chunk = chunks[chunkIndex];
          const media = chunk.map((attachment, idx) => {
            const type = detectAttachmentType(attachment);
            const mediaType =
              type === "image"
                ? "photo"
                : type === "video"
                  ? "video"
                  : type === "audio"
                    ? "audio"
                    : "document";

            const mediaSource = this.resolveSourceForMediaGroup(attachment) as unknown;
            const isFirstItemOverall = chunkIndex === 0 && idx === 0;
            const caption = isFirstItemOverall ? text : undefined;

            const item: Record<string, unknown> = {
              type: mediaType,
              media: mediaSource,
            };

            if (caption) {
              item.caption = caption;
              if (telegramParseMode) item.parse_mode = telegramParseMode;
            }

            return item;
          });

          const extra: Record<string, unknown> = {};
          if (chunkIndex === 0 && replyParameters) {
            extra.reply_parameters = replyParameters;
          }

          await this.bot.telegram.callApi("sendMediaGroup", {
            chat_id: chatId,
            media: media as unknown as never,
            ...extra,
          } as unknown as never);
        }

        // If we used the message text as a caption, do not send a separate text message.
        // If there were more than 10 items and we chunked, the caption is still attached to the first chunk.
        return;
      }
    }

    let replied = false;

    if (attachments?.length) {
      for (const attachment of attachments) {
        const isFirst = !replied;
        const caption = attachments.length === 1 ? text : undefined;
        await this.sendAttachment(chatId, attachment, caption, {
          parseMode: options.parseMode,
          replyToMessageId: isFirst ? options.replyToMessageId : undefined,
        });
        replied = true;
      }
      if (attachments.length > 1 && text) {
        await this.bot.telegram.sendMessage(chatId, text, {
          parse_mode: telegramParseMode,
          ...(replyParameters && !replied ? { reply_parameters: replyParameters } : {}),
        } as unknown as Record<string, unknown>);
      }
    } else if (text) {
      await this.bot.telegram.sendMessage(chatId, text, {
        parse_mode: telegramParseMode,
        ...(replyParameters ? { reply_parameters: replyParameters } : {}),
      } as unknown as Record<string, unknown>);
    }
  }

  private async sendAttachment(
    chatId: string,
    attachment: Attachment,
    caption?: string,
    options: SendMessageOptions = {}
  ): Promise<void> {
    const type = detectAttachmentType(attachment);
    const source = this.resolveSource(attachment);
    const telegramParseMode = toTelegramParseMode(options.parseMode);
    const replyParameters =
      options.replyToMessageId && options.replyToMessageId.trim()
        ? {
            message_id: parseTelegramMessageId(
              options.replyToMessageId,
              "reply-to-channel-message-id"
            ),
          }
        : undefined;

    const extra: Record<string, unknown> = {
      ...(caption ? { caption } : {}),
      ...(telegramParseMode ? { parse_mode: telegramParseMode } : {}),
      ...(replyParameters ? { reply_parameters: replyParameters } : {}),
    };

    switch (type) {
      case "image":
        await this.bot.telegram.sendPhoto(chatId, source, extra as never);
        break;
      case "video":
        await this.bot.telegram.sendVideo(chatId, source, extra as never);
        break;
      case "audio":
        await this.bot.telegram.sendAudio(chatId, source, extra as never);
        break;
      case "file":
        await this.bot.telegram.sendDocument(chatId, source, extra as never);
        break;
    }
  }

  private resolveSource(attachment: Attachment): string | { source: fs.ReadStream } {
    // If we have the original Telegram file_id, use it directly (efficient, no re-upload)
    if (attachment.telegramFileId) {
      return attachment.telegramFileId;
    }

    const source = attachment.source;

    // URL
    if (/^https?:\/\//i.test(source)) {
      return source;
    }

    // Local file path (absolute or relative)
    const resolvedPath = path.resolve(source);
    const isProbablyLocalPath =
      path.isAbsolute(source) ||
      source.startsWith("./") ||
      source.startsWith("../") ||
      source.includes("/") ||
      source.includes("\\") ||
      path.extname(source) !== "" ||
      fs.existsSync(resolvedPath);

    if (isProbablyLocalPath) {
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Telegram attachment source file not found: ${resolvedPath}`);
      }
      return { source: fs.createReadStream(resolvedPath) };
    }

    return source;
  }

  private resolveSourceForMediaGroup(attachment: Attachment): string | { source: string; filename?: string } {
    // Prefer original Telegram file_id when available (no upload)
    if (attachment.telegramFileId) {
      return attachment.telegramFileId;
    }

    const source = attachment.source;

    // URL
    if (/^https?:\/\//i.test(source)) {
      return source;
    }

    // Local file path: for sendMediaGroup we must provide an InputFile object
    // with a string source path so Telegraf can preserve the original filename.
    const resolvedPath = path.resolve(source);
    const isProbablyLocalPath =
      path.isAbsolute(source) ||
      source.startsWith("./") ||
      source.startsWith("../") ||
      source.includes("/") ||
      source.includes("\\") ||
      path.extname(source) !== "" ||
      fs.existsSync(resolvedPath);

    if (isProbablyLocalPath) {
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Telegram attachment source file not found: ${resolvedPath}`);
      }
      return { source: resolvedPath, filename: attachment.filename };
    }

    // Fallback: treat as Telegram file_id
    return source;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.handlers.push(handler);
  }

  onCommand(handler: ChannelCommandHandler): void {
    this.commandHandlers.push(handler);
  }

  async setReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    const trimmed = emoji.trim();
    if (!trimmed) {
      throw new Error("Reaction emoji is required");
    }

    const mid = parseTelegramMessageId(messageId, "channel-message-id");

    await this.bot.telegram.callApi("setMessageReaction", {
      chat_id: chatId,
      message_id: mid,
      reaction: [{ type: "emoji", emoji: trimmed as unknown as never }],
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return; // Already started, ignore duplicate calls
    }
    this.started = true;
    this.stopped = false;
    logEvent("info", "adapter-start", { "adapter-type": this.platform });

    // Fire-and-forget: launch() only resolves when the bot stops,
    // so we run the retry loop in the background.
    this.launchWithRetry();
  }

  private async launchWithRetry(): Promise<void> {
    let attempt = 0;

    while (!this.stopped) {
      try {
        await this.bot.launch({ dropPendingUpdates: true });
        return; // Clean exit when bot stops normally
      } catch (err) {
        if (this.stopped) return;

        if (isGetUpdatesConflict(err)) {
          const delayMs = computeBackoff(attempt);
          logEvent("warn", "adapter-launch-retry", {
            "adapter-type": this.platform,
            "delay-ms": delayMs,
            attempt: attempt + 1,
            reason: "telegram-409-getupdates-conflict",
          });
          await sleep(delayMs);
          attempt++;
          continue;
        }

        // Non-recoverable error
        logEvent("error", "adapter-launch-failed", {
          "adapter-type": this.platform,
          error: errorMessage(err),
        });
        return;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.bot.stop();
    logEvent("info", "adapter-stop", { "adapter-type": this.platform });
  }
}
