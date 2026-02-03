import { Telegraf } from "telegraf";
import type {
  ChatAdapter,
  ChannelMessageHandler,
  MessageContent,
  ChannelCommandHandler,
  ChannelCommand,
  SendMessageOptions,
} from "./types.js";
import { getDefaultMediaDir } from "../shared/defaults.js";
import { parseTelegramMessageId } from "../shared/telegram-message-id.js";
import { buildTelegramChannelMessage, type MessageContext } from "./telegram/incoming.js";
import { sendTelegramMessage } from "./telegram/outgoing.js";
import { computeBackoff, isGetUpdatesConflict, sleep } from "./telegram/shared.js";

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

