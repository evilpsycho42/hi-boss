import { Telegraf } from "telegraf";
import type {
  ChatAdapter,
  ChannelMessage,
  ChannelMessageHandler,
  MessageContent,
  ChannelCommandHandler,
  ChannelCommand,
  ChannelCommandResponse,
  SendMessageOptions,
  TelegramInlineKeyboardButton,
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
import type { UiLocale } from "../shared/ui-locale.js";
import { getUiText } from "../shared/ui-text.js";
import { SESSIONS_CALLBACK_PREFIX } from "../shared/session-callbacks.js";

/** Milliseconds to wait for additional album parts before flushing. */
const MEDIA_GROUP_DEBOUNCE_MS = 500;
/** Telegram typing status expires quickly; refresh every few seconds while active. */
const TELEGRAM_TYPING_HEARTBEAT_MS = 4500;
/** Prevent noisy logs if chat action repeatedly fails (e.g., chat blocked). */
const TELEGRAM_TYPING_ERROR_THROTTLE_MS = 60_000;
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
  /** Active typing heartbeat timers keyed by chat id. */
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Guards against overlapping chat-action calls per chat id. */
  private typingInFlight = new Set<string>();
  /** Last warning timestamp for chat-action failures per chat id. */
  private typingLastErrorAtMs = new Map<string, number>();
  private readonly uiLocale: UiLocale;

  constructor(token: string, uiLocale: UiLocale = "en") {
    const apiRoot = process.env.TELEGRAM_API_ROOT;
    this.bot = new Telegraf(token, apiRoot ? { telegram: { apiRoot } } : {});
    this.mediaDir = getHiBossPaths().mediaDir;
    this.uiLocale = uiLocale;
    this.setupListeners();
  }

  private static extractCommandArgs(text: string, command: string): string {
    const re = new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, "i");
    return text.replace(re, "");
  }

  private parseSessionsCallback(data: string): { tab: string; page: number } | null {
    if (!data.startsWith(SESSIONS_CALLBACK_PREFIX)) return null;
    const parts = data.split(":");
    if (parts.length !== 4) return null;
    const tab = parts[2]?.trim();
    const pageRaw = Number(parts[3]);
    if (!tab || !Number.isFinite(pageRaw)) return null;
    return { tab, page: Math.max(1, Math.trunc(pageRaw)) };
  }

  private toInlineKeyboard(
    keyboard: TelegramInlineKeyboardButton[][]
  ): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
    return {
      inline_keyboard: keyboard.map((row) =>
        row.map((item) => ({
          text: item.text,
          callback_data: item.callbackData,
        }))
      ),
    };
  }

  private async safeAnswerCallback(callbackQueryId?: string): Promise<void> {
    if (!callbackQueryId) return;
    try {
      await this.bot.telegram.answerCbQuery(callbackQueryId);
    } catch {
      // best-effort
    }
  }

  private async sendCommandResponse(command: ChannelCommand, response: ChannelCommandResponse): Promise<void> {
    const chatId = command.chatId;
    const text = response.text?.trim();
    if (!text) {
      await this.safeAnswerCallback(command.callbackQueryId);
      return;
    }

    const inlineKeyboard = response.telegram?.inlineKeyboard;
    const replyMarkup = inlineKeyboard ? this.toInlineKeyboard(inlineKeyboard) : undefined;
    const safeText = text.length <= TELEGRAM_MAX_TEXT_CHARS
      ? text
      : `${text.slice(0, TELEGRAM_MAX_TEXT_CHARS - 3)}...`;

    if (command.isCallback && response.telegram?.editMessageId) {
      try {
        const messageId = parseTelegramMessageId(response.telegram.editMessageId, "callback-message-id");
        await this.bot.telegram.editMessageText(chatId, messageId, undefined, safeText, {
          ...(replyMarkup ? { reply_markup: replyMarkup as never } : {}),
        } as never);
        await this.safeAnswerCallback(command.callbackQueryId);
        return;
      } catch {
        // Fallback to sending a new message if edit fails (e.g., message too old).
      }
    }

    if (replyMarkup) {
      await this.bot.telegram.sendMessage(chatId, safeText, {
        reply_markup: replyMarkup as never,
      } as never);
      await this.safeAnswerCallback(command.callbackQueryId);
      return;
    }

    const chunks = splitTextForTelegram(text, TELEGRAM_MAX_TEXT_CHARS);
    for (const chunk of chunks) {
      await this.bot.telegram.sendMessage(chatId, chunk);
    }
    await this.safeAnswerCallback(command.callbackQueryId);
  }

  private async dispatchCommand(ctx: any, commandName: string): Promise<void> {
    const chatId = String(ctx.chat?.id ?? "");
    if (!chatId) return;

    const username = ctx.from?.username;
    const authorId =
      ctx.from?.id !== undefined && ctx.from?.id !== null
        ? String(ctx.from.id)
        : undefined;
    const rawText = typeof ctx.message?.text === "string" ? ctx.message.text : `/${commandName}`;

    const command: ChannelCommand = {
      command: commandName,
      args: TelegramAdapter.extractCommandArgs(rawText, commandName),
      adapterType: this.platform,
      chatId,
      authorId,
      authorUsername: username,
      messageId: ctx.message?.message_id != null ? String(ctx.message.message_id) : undefined,
    };

    let response: ChannelCommandResponse | undefined;

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

    await this.sendCommandResponse(command, response);
  }

  private async dispatchCallback(ctx: any): Promise<void> {
    const callback = ctx.callbackQuery as { id?: string; data?: string; message?: { message_id?: number } } | undefined;
    const data = typeof callback?.data === "string" ? callback.data : "";
    const parsed = this.parseSessionsCallback(data);
    if (!parsed) {
      await this.safeAnswerCallback(callback?.id);
      return;
    }

    const chatId = String(ctx.chat?.id ?? "");
    if (!chatId) {
      await this.safeAnswerCallback(callback?.id);
      return;
    }

    const command: ChannelCommand = {
      command: "sessions",
      args: `tab=${parsed.tab} page=${parsed.page}`,
      adapterType: this.platform,
      chatId,
      authorId: ctx.from?.id !== undefined && ctx.from?.id !== null ? String(ctx.from.id) : undefined,
      authorUsername: ctx.from?.username,
      messageId:
        callback?.message?.message_id !== undefined && callback?.message?.message_id !== null
          ? String(callback.message.message_id)
          : undefined,
      callbackQueryId: callback?.id,
      isCallback: true,
    };

    let response: ChannelCommandResponse | undefined;
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
      await this.safeAnswerCallback(command.callbackQueryId);
      return;
    }
    await this.sendCommandResponse(command, response);
  }

  private setupListeners(): void {
    this.bot.command("new", async (ctx) => {
      await this.dispatchCommand(ctx, "new");
    });

    this.bot.command("status", async (ctx) => {
      await this.dispatchCommand(ctx, "status");
    });

    this.bot.command("trace", async (ctx) => {
      await this.dispatchCommand(ctx, "trace");
    });

    this.bot.command("provider", async (ctx) => {
      await this.dispatchCommand(ctx, "provider");
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
    this.bot.command("sessions", async (ctx) => {
      await this.dispatchCommand(ctx, "sessions");
    });
    this.bot.command("session", async (ctx) => {
      await this.dispatchCommand(ctx, "session");
    });
    this.bot.on("callback_query", async (ctx) => {
      await this.dispatchCallback(ctx);
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

  async setTyping(chatId: string, active: boolean): Promise<void> {
    if (!chatId.trim()) return;

    if (!active) {
      const timer = this.typingTimers.get(chatId);
      if (timer) clearInterval(timer);
      this.typingTimers.delete(chatId);
      this.typingInFlight.delete(chatId);
      return;
    }

    if (this.typingTimers.has(chatId)) {
      return;
    }

    await this.sendTypingHeartbeat(chatId);

    const timer = setInterval(() => {
      void this.sendTypingHeartbeat(chatId);
    }, TELEGRAM_TYPING_HEARTBEAT_MS);

    this.typingTimers.set(chatId, timer);
  }

  private async sendTypingHeartbeat(chatId: string): Promise<void> {
    if (this.stopped || !this.started) return;
    if (this.typingInFlight.has(chatId)) return;

    this.typingInFlight.add(chatId);
    try {
      await this.bot.telegram.sendChatAction(chatId, "typing");
    } catch (err) {
      const nowMs = Date.now();
      const lastMs = this.typingLastErrorAtMs.get(chatId) ?? 0;
      if (nowMs - lastMs >= TELEGRAM_TYPING_ERROR_THROTTLE_MS) {
        this.typingLastErrorAtMs.set(chatId, nowMs);
        console.warn(`[${this.platform}] Failed to send typing action for chat ${chatId}:`, err);
      }
    } finally {
      this.typingInFlight.delete(chatId);
    }
  }

  private async registerCommands(): Promise<void> {
    const commands = getUiText(this.uiLocale).telegram.commandDescriptions;
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
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
    this.typingInFlight.clear();
    this.typingLastErrorAtMs.clear();
    this.bot.stop();
    console.log(`[${this.platform}] Bot stopped`);
  }
}
