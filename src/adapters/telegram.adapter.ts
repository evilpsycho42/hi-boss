import { Telegraf } from "telegraf";
import type {
  ChatAdapter,
  ChannelMessageHandler,
  MessageContent,
  ChannelCommandHandler,
  ChannelCommand,
  SendMessageOptions,
} from "./types.js";
import { getHiBossPaths } from "../shared/hiboss-paths.js";
import { parseTelegramMessageId } from "../shared/telegram-message-id.js";
import { buildTelegramChannelMessage, type MessageContext } from "./telegram/incoming.js";
import { sendTelegramMessage } from "./telegram/outgoing.js";
import {
  computeBackoff,
  isGetUpdatesConflict,
  sleep,
  splitTextForTelegram,
  TELEGRAM_MAX_TEXT_CHARS,
} from "./telegram/shared.js";

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
    this.mediaDir = getHiBossPaths().mediaDir;
    this.setupListeners();
  }

  private static extractCommandArgs(text: string, command: string): string {
    const re = new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, "i");
    return text.replace(re, "");
  }

  private async dispatchCommand(ctx: any, commandName: string): Promise<void> {
    const chatId = String(ctx.chat?.id ?? "");
    if (!chatId) return;

    const username = ctx.from?.username;
    const rawText = typeof ctx.message?.text === "string" ? ctx.message.text : `/${commandName}`;

    const command: ChannelCommand = {
      command: commandName,
      args: TelegramAdapter.extractCommandArgs(rawText, commandName),
      chatId,
      authorUsername: username,
    };

    let response: MessageContent | undefined;

    for (const handler of this.commandHandlers) {
      try {
        const result = await handler(command);
        if (result && (typeof result.text === "string" || (result.attachments?.length ?? 0) > 0)) {
          response = result;
          break;
        }
      } catch (err) {
        console.error(`[${this.platform}] command handler error:`, err);
      }
    }

    if (!response?.text) {
      // Boss-only commands: non-boss users get no reply.
      return;
    }

    const chunks = splitTextForTelegram(response.text, TELEGRAM_MAX_TEXT_CHARS);
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  }

  private setupListeners(): void {
    this.bot.command("new", async (ctx) => {
      await this.dispatchCommand(ctx, "new");
    });

    this.bot.command("status", async (ctx) => {
      await this.dispatchCommand(ctx, "status");
    });

    this.bot.command("abort", async (ctx) => {
      await this.dispatchCommand(ctx, "abort");
    });

    this.bot.on("text", (ctx) => this.handleMessage(ctx as unknown as MessageContext));
    this.bot.on("photo", (ctx) => this.handleMessage(ctx as unknown as MessageContext));
    this.bot.on("video", (ctx) => this.handleMessage(ctx as unknown as MessageContext));
    this.bot.on("document", (ctx) => this.handleMessage(ctx as unknown as MessageContext));
    this.bot.on("voice", (ctx) => this.handleMessage(ctx as unknown as MessageContext));
    this.bot.on("audio", (ctx) => this.handleMessage(ctx as unknown as MessageContext));
  }

  private async handleMessage(ctx: MessageContext): Promise<void> {
    const message = await buildTelegramChannelMessage({
      platform: this.platform,
      telegram: this.bot.telegram as any,
      ctx,
      mediaDir: this.mediaDir,
    });

    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  async sendMessage(chatId: string, content: MessageContent, options: SendMessageOptions = {}): Promise<void> {
    await sendTelegramMessage(this.bot.telegram as any, chatId, content, options);
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
