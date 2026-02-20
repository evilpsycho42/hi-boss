import { Telegraf } from "telegraf";
import type {
  ChatAdapter,
  ChannelMessage,
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
  isTransientNetworkError,
  sleep,
  splitTextForTelegram,
  TELEGRAM_MAX_TEXT_CHARS,
} from "./telegram/shared.js";

/** Milliseconds to wait for additional album parts before flushing. */
const MEDIA_GROUP_DEBOUNCE_MS = 500;

/**
 * Telegram adapter for the chat bot.
 *
 * Media groups (albums): When users send multiple images/videos together,
 * Telegram delivers each as a separate message sharing a `media_group_id`.
 * We buffer these for a short debounce window and emit a single combined
 * ChannelMessage with all attachments and the caption (if any).
 */
export class TelegramAdapter implements ChatAdapter {
  readonly platform = "telegram";
  private bot: Telegraf;
  private handlers: ChannelMessageHandler[] = [];
  private commandHandlers: ChannelCommandHandler[] = [];
  private mediaDir: string;
  private stopped = false;
  private started = false;

  /** Buffered ChannelMessages keyed by media_group_id, waiting to be merged. */
  private mediaGroupBuffer = new Map<string, ChannelMessage[]>();
  /** Debounce timers keyed by media_group_id. */
  private mediaGroupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(token: string) {
    const apiRoot = process.env.TELEGRAM_API_ROOT;
    this.bot = new Telegraf(token, apiRoot ? { telegram: { apiRoot } } : {});
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
      messageId: ctx.message?.message_id != null ? String(ctx.message.message_id) : undefined,
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

    this.bot.command("isolated", async (ctx) => {
      await this.dispatchCommand(ctx, "isolated");
    });

    this.bot.command("clone", async (ctx) => {
      await this.dispatchCommand(ctx, "clone");
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

    // Check for media_group_id (albums)
    const raw = ctx.message as unknown as { media_group_id?: string };
    const groupId = raw.media_group_id;

    if (groupId) {
      // Buffer this message; debounce before flushing
      let buffer = this.mediaGroupBuffer.get(groupId);
      if (!buffer) {
        buffer = [];
        this.mediaGroupBuffer.set(groupId, buffer);
      }
      buffer.push(message);

      // Reset the debounce timer for this group
      const existing = this.mediaGroupTimers.get(groupId);
      if (existing) clearTimeout(existing);

      this.mediaGroupTimers.set(
        groupId,
        setTimeout(() => this.flushMediaGroup(groupId), MEDIA_GROUP_DEBOUNCE_MS),
      );
      return;
    }

    // Non-album message: dispatch immediately
    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  /**
   * Merge buffered album messages into a single ChannelMessage and dispatch.
   */
  private async flushMediaGroup(groupId: string): Promise<void> {
    this.mediaGroupTimers.delete(groupId);
    const messages = this.mediaGroupBuffer.get(groupId);
    this.mediaGroupBuffer.delete(groupId);
    if (!messages || messages.length === 0) return;

    // Use the first message as the base (lowest message_id = earliest)
    messages.sort((a, b) => Number(a.id) - Number(b.id));
    const merged = { ...messages[0] };

    // Combine text: use the caption from whichever message has it
    const textSource = messages.find((m) => m.content.text);
    const allAttachments = messages.flatMap((m) => m.content.attachments ?? []);

    merged.content = {
      text: textSource?.content.text,
      attachments: allAttachments.length > 0 ? allAttachments : undefined,
    };

    for (const handler of this.handlers) {
      await handler(merged);
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

  private async registerCommands(): Promise<void> {
    const commands = [
      { command: "new", description: "Start a new session" },
      { command: "status", description: "Show agent status" },
      { command: "abort", description: "Abort current run and clear message queue" },
      { command: "isolated", description: "One-shot with clean context" },
      { command: "clone", description: "One-shot with current session context" },
    ];
    try {
      await this.bot.telegram.setMyCommands(commands);
      console.log(`[${this.platform}] Commands registered (${commands.length})`);
    } catch (err) {
      console.error(`[${this.platform}] Failed to register commands:`, err);
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return; // Already started, ignore duplicate calls
    }
    this.started = true;
    this.stopped = false;
    console.log(`[${this.platform}] Bot starting...`);

    // Register commands with Telegram so they appear in the / menu.
    await this.registerCommands();

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

        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        if (isGetUpdatesConflict(err) || isTransientNetworkError(err) || isTimeout) {
          const delayMs = computeBackoff(attempt);
          const reason = isGetUpdatesConflict(err) ? "409 conflict" : isTimeout ? "handler timeout" : "network error";
          console.log(`[${this.platform}] ${reason}, retrying in ${delayMs}ms (attempt ${attempt + 1})`);
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
    for (const timer of this.mediaGroupTimers.values()) clearTimeout(timer);
    this.mediaGroupTimers.clear();
    this.mediaGroupBuffer.clear();
    this.bot.stop();
    console.log(`[${this.platform}] Bot stopped`);
  }
}
