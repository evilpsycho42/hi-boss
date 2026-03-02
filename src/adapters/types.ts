/**
 * Address format for routing messages.
 * "agent:<name>" | "agent:<name>:new" | "agent:<name>:<chat-id>"
 * | "team:<name>" | "team:<name>:<agent>" | "channel:<adapter>:<chat-id>"
 */
import { isValidAgentName, isValidTeamName } from "../shared/validation.js";

const ADAPTER_TYPE_REGEX = /^[a-z][a-z0-9-]*$/;

export type Address = string;

/**
 * Parse an address string into its components.
 */
export function parseAddress(address: Address):
  | { type: "agent"; agentName: string }
  | { type: "agent-new-chat"; agentName: string }
  | { type: "agent-chat"; agentName: string; chatId: string }
  | { type: "team"; teamName: string }
  | { type: "team-mention"; teamName: string; agentName: string }
  | { type: "channel"; adapter: string; chatId: string } {
  const trimmed = address.trim();

  if (trimmed.startsWith("agent:")) {
    const rest = trimmed.slice(6);
    const parts = rest.split(":");
    const agentName = parts.shift() ?? "";
    if (!agentName || !isValidAgentName(agentName)) {
      throw new Error(`Invalid address format: ${address}`);
    }
    if (parts.length === 0) {
      return { type: "agent", agentName };
    }
    const chatTarget = parts.join(":").trim();
    if (!chatTarget) {
      throw new Error(`Invalid address format: ${address}`);
    }
    if (chatTarget === "new") {
      return { type: "agent-new-chat", agentName };
    }
    return { type: "agent-chat", agentName, chatId: chatTarget };
  }
  if (trimmed.startsWith("team:")) {
    const parts = trimmed.slice(5).split(":");
    if (parts.length === 1) {
      const teamName = parts[0] ?? "";
      if (!teamName || !isValidTeamName(teamName)) {
        throw new Error(`Invalid address format: ${address}`);
      }
      return { type: "team", teamName };
    }
    if (parts.length === 2) {
      const teamName = parts[0] ?? "";
      const agentName = parts[1] ?? "";
      if (!teamName || !isValidTeamName(teamName) || !agentName || !isValidAgentName(agentName)) {
        throw new Error(`Invalid address format: ${address}`);
      }
      return { type: "team-mention", teamName, agentName };
    }
  }
  if (trimmed.startsWith("channel:")) {
    const parts = trimmed.slice(8).split(":");
    if (parts.length >= 2) {
      const adapter = parts[0];
      const chatId = parts.slice(1).join(":").trim();
      if (!adapter || !ADAPTER_TYPE_REGEX.test(adapter)) {
        throw new Error(`Invalid address format: ${address}`);
      }
      if (!chatId) {
        throw new Error(`Invalid address format: ${address}`);
      }
      return { type: "channel", adapter, chatId };
    }
  }
  throw new Error(`Invalid address format: ${address}`);
}

/**
 * Format an agent address.
 */
export function formatAgentAddress(agentName: string): Address {
  return `agent:${agentName}`;
}

/**
 * Format a team broadcast address.
 */
export function formatTeamAddress(teamName: string): Address {
  return `team:${teamName}`;
}

/**
 * Format a team mention address.
 */
export function formatTeamMentionAddress(teamName: string, agentName: string): Address {
  return `team:${teamName}:${agentName}`;
}

/**
 * Format a channel address.
 */
export function formatChannelAddress(adapter: string, chatId: string): Address {
  return `channel:${adapter}:${chatId}`;
}

/**
 * Unified attachment format for both incoming and outgoing messages.
 * Type is inferred from file extension.
 */
export interface Attachment {
  source: string;           // Local file path (for Telegram media, downloaded to ~/hiboss/media/)
  filename?: string;        // Helps with type detection and display
  telegramFileId?: string;  // Preserved for efficient re-sending via Telegram API
}

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "avi", "webm", "mkv"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "oga", "opus", "aac", "flac"];

/**
 * Detect attachment type from source or filename extension.
 */
export function detectAttachmentType(attachment: Attachment): "image" | "video" | "audio" | "file" {
  const name = attachment.filename ?? attachment.source;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";

  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
  return "file";
}

/**
 * Unified message format across chat platforms (renamed from Message).
 *
 * Note: Media groups (albums) in Telegram are delivered as separate messages,
 * each containing one attachment. They share the same `media_group_id` in the
 * raw payload if grouping is needed in the future.
 */
export interface ChannelMessage {
  id: string;
  platform: string;
  channelUser: {
    id: string;
    username?: string;
    displayName: string;
  };
  /**
   * If this message is a reply to (quotes) another message in the same chat,
   * this contains minimal info about the target message.
   */
  inReplyTo?: {
    channelMessageId: string;
    channelUser?: {
      id: string;
      username?: string;
      displayName: string;
    };
    text?: string;
  };
  chat: {
    id: string;
    name?: string;
  };
  content: {
    text?: string;
    attachments?: Attachment[];
  };
  raw: unknown;
}

export type ChannelMessageHandler = (message: ChannelMessage) => void | Promise<void>;

/**
 * Command from a chat platform (e.g., /new, /help).
 */
export interface ChannelCommand {
  command: string;           // Command name without slash (e.g., "new")
  args: string;              // Arguments after command
  adapterType?: string;      // Adapter origin (e.g., "telegram")
  chatId: string;            // Chat ID where command was issued
  channelUserId?: string;    // Channel-side user ID of command issuer
  channelUsername?: string;  // Channel-side username of command issuer
  fromBoss?: boolean;        // Whether command sender resolved to role "boss"
  userToken?: string;        // Resolved global user token of command issuer
  messageId?: string;        // Platform message ID of the command message
  callbackQueryId?: string;  // Platform callback query ID (for interactive buttons)
  isCallback?: boolean;      // True when command was triggered by a button callback
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callbackData: string;
}

export interface ChannelCommandResponse {
  text?: string;
  attachments?: Attachment[];
  telegram?: {
    inlineKeyboard?: TelegramInlineKeyboardButton[][];
    editMessageId?: string;
  };
}

export type MessageContent = ChannelMessage["content"];
export type ChannelCommandHandler =
  (command: ChannelCommand) => ChannelCommandResponse | void | Promise<ChannelCommandResponse | void>;

export type OutgoingParseMode = "plain" | "markdownv2" | "html";

export interface SendMessageOptions {
  parseMode?: OutgoingParseMode;
  replyToMessageId?: string;
}

export interface ChatAdapter {
  readonly platform: string;
  /**
   * Send a message to a chat.
   * @param chatId - Target chat ID
   * @param content - Message content (text and/or attachments)
   * @param options - Optional send options (formatting, reply threading, etc.)
   *
   * Note: When sending multiple attachments, platforms may deliver them as
   * separate messages (e.g., Telegram media groups).
   */
  sendMessage(chatId: string, content: MessageContent, options?: SendMessageOptions): Promise<void>;
  onMessage(handler: ChannelMessageHandler): void;
  onCommand?(handler: ChannelCommandHandler): void;
  setReaction?(chatId: string, messageId: string, emoji: string): Promise<void>;
  /**
   * Toggle chat "typing…" presence when supported by the adapter.
   * Best-effort: adapters may ignore this if the platform lacks such concept.
   */
  setTyping?(chatId: string, active: boolean): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function buildSemanticName(msg: ChannelMessage): string {
  const name = msg.channelUser.username
    ? `${msg.channelUser.displayName} (@${msg.channelUser.username})`
    : msg.channelUser.displayName;

  return msg.chat.name ? `${name} in "${msg.chat.name}"` : name;
}

export function formatForAgent(msg: ChannelMessage): string {
  const semanticName = buildSemanticName(msg);

  let result = `[${semanticName}]: `;

  if (msg.content.text) {
    result += msg.content.text;
  }

  if (msg.content.attachments?.length) {
    const attachmentInfo = msg.content.attachments
      .map((a) => `[${detectAttachmentType(a)}: ${a.source}]`)
      .join(" ");
    result += (msg.content.text ? "\n" : "") + attachmentInfo;
  }

  return result;
}
