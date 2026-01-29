import { Telegraf, Context } from "telegraf";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { Message as TelegramMessage } from "telegraf/types";
import type { ChatAdapter, ChannelMessage, MessageContent, ChannelMessageHandler, Attachment, ChannelCommandHandler, ChannelCommand } from "./types.js";
import { detectAttachmentType } from "./types.js";
import { getDefaultMediaDir } from "../shared/defaults.js";

type TextContext = Context & { message: TelegramMessage.TextMessage };
type PhotoContext = Context & { message: TelegramMessage.PhotoMessage };
type VideoContext = Context & { message: TelegramMessage.VideoMessage };
type DocumentContext = Context & { message: TelegramMessage.DocumentMessage };
type VoiceContext = Context & { message: TelegramMessage.VoiceMessage };
type AudioContext = Context & { message: TelegramMessage.AudioMessage };
type MessageContext = TextContext | PhotoContext | VideoContext | DocumentContext | VoiceContext | AudioContext;

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
    const message = await this.buildMessage(ctx);

    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  private async buildMessage(ctx: MessageContext): Promise<ChannelMessage> {
    const telegramMsg = ctx.message;
    const chat = ctx.chat!;
    const from = ctx.from!;

    const attachments = await this.extractAttachments(ctx);
    const text = this.extractText(telegramMsg);

    const chatName =
      chat.type === "group" || chat.type === "supergroup"
        ? chat.title
        : undefined;

    return {
      id: String(telegramMsg.message_id),
      platform: this.platform,
      author: {
        id: String(from.id),
        username: from.username,
        displayName: from.first_name,
      },
      chat: {
        id: String(chat.id),
        name: chatName,
      },
      content: {
        text,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      raw: telegramMsg,
    };
  }

  private extractText(msg: MessageContext["message"]): string | undefined {
    if ("text" in msg) return msg.text;
    if ("caption" in msg) return msg.caption;
    return undefined;
  }

  private async extractAttachments(ctx: MessageContext): Promise<Attachment[]> {
    const msg = ctx.message;
    const attachments: Attachment[] = [];

    if ("photo" in msg && msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      attachments.push(await this.getTelegramAttachment(photo.file_id));
    }

    if ("video" in msg && msg.video) {
      attachments.push(
        await this.getTelegramAttachment(msg.video.file_id, msg.video.file_name)
      );
    }

    if ("document" in msg && msg.document) {
      attachments.push(
        await this.getTelegramAttachment(
          msg.document.file_id,
          msg.document.file_name
        )
      );
    }

    if ("voice" in msg && msg.voice) {
      attachments.push(
        await this.getTelegramAttachment(msg.voice.file_id, `voice_${Date.now()}.oga`)
      );
    }

    if ("audio" in msg && msg.audio) {
      attachments.push(
        await this.getTelegramAttachment(msg.audio.file_id, msg.audio.file_name)
      );
    }

    return attachments;
  }

  /**
   * Get a unique file path in the given directory, adding incremental suffix for duplicates.
   */
  private getUniqueFilePath(dir: string, filename: string): string {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    let candidate = path.join(dir, filename);
    let counter = 1;

    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, `${base}_${counter}${ext}`);
      counter++;
    }
    return candidate;
  }

  /**
   * Download Telegram file and store locally.
   *
   * Downloads the file to ~/.hiboss/media/ using the original filename when
   * available, with incremental suffix for duplicates. The original file_id
   * is preserved for efficient re-sending via Telegram API.
   */
  private async getTelegramAttachment(
    fileId: string,
    preferredFilename?: string
  ): Promise<Attachment> {
    const file = await this.bot.telegram.getFile(fileId);
    const derivedFilename = file.file_path
      ? path.posix.basename(file.file_path)
      : undefined;
    const filename = preferredFilename ?? derivedFilename;

    // Derive extension from file_path (e.g., "photos/file_123.jpg" -> "jpg")
    const ext = file.file_path
      ? path.extname(file.file_path).slice(1) || "bin"
      : "bin";

    // Get download URL and fetch the file
    const fileUrl = await this.bot.telegram.getFileLink(fileId);
    const response = await fetch(fileUrl.toString());
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    // Ensure media directory exists
    if (!fs.existsSync(this.mediaDir)) {
      fs.mkdirSync(this.mediaDir, { recursive: true });
    }

    // Use original filename when available, with incremental suffix for duplicates
    const targetFilename = filename || `file_${crypto.randomUUID()}.${ext}`;
    const localPath = this.getUniqueFilePath(this.mediaDir, targetFilename);
    fs.writeFileSync(localPath, buffer);

    return {
      source: localPath,
      filename,
      telegramFileId: fileId,
    };
  }

  async sendMessage(chatId: string, content: MessageContent): Promise<void> {
    const { text, attachments } = content;

    if (attachments?.length) {
      for (const attachment of attachments) {
        const caption = attachments.length === 1 ? text : undefined;
        await this.sendAttachment(chatId, attachment, caption);
      }
      if (attachments.length > 1 && text) {
        await this.bot.telegram.sendMessage(chatId, text);
      }
    } else if (text) {
      await this.bot.telegram.sendMessage(chatId, text);
    }
  }

  private async sendAttachment(
    chatId: string,
    attachment: Attachment,
    caption?: string
  ): Promise<void> {
    const type = detectAttachmentType(attachment);
    const source = this.resolveSource(attachment);

    switch (type) {
      case "image":
        await this.bot.telegram.sendPhoto(chatId, source, { caption });
        break;
      case "video":
        await this.bot.telegram.sendVideo(chatId, source, { caption });
        break;
      case "audio":
        await this.bot.telegram.sendAudio(chatId, source, { caption });
        break;
      case "file":
        await this.bot.telegram.sendDocument(chatId, source, { caption });
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

  onMessage(handler: ChannelMessageHandler): void {
    this.handlers.push(handler);
  }

  onCommand(handler: ChannelCommandHandler): void {
    this.commandHandlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.started) {
      return; // Already started, ignore duplicate calls
    }
    this.started = true;
    this.stopped = false;
    console.log(`[${this.platform}] Bot starting...`);

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
          console.log(`[${this.platform}] 409 conflict, retrying in ${delayMs}ms (attempt ${attempt + 1})`);
          await sleep(delayMs);
          attempt++;
          continue;
        }

        // Non-recoverable error
        console.error(`[${this.platform}] Bot launch error:`, err);
        return;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.bot.stop();
    console.log(`[${this.platform}] Bot stopped`);
  }
}
