/**
 * Address format for routing messages.
 * "agent:<name>" | "channel:<adapter>:<chat-id>"
 */
export type Address = string;

/**
 * Parse an address string into its components.
 */
export function parseAddress(address: Address):
  | { type: "agent"; agentName: string }
  | { type: "channel"; adapter: string; chatId: string } {
  if (address.startsWith("agent:")) {
    return { type: "agent", agentName: address.slice(6) };
  }
  if (address.startsWith("channel:")) {
    const parts = address.slice(8).split(":");
    if (parts.length >= 2) {
      return { type: "channel", adapter: parts[0], chatId: parts.slice(1).join(":") };
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
  author: {
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
    author?: {
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
  chatId: string;            // Chat ID where command was issued
  authorUsername?: string;   // Username of command issuer
}

export type MessageContent = ChannelMessage["content"];
export type ChannelCommandHandler =
  (command: ChannelCommand) => MessageContent | void | Promise<MessageContent | void>;

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
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function buildSemanticName(msg: ChannelMessage): string {
  const name = msg.author.username
    ? `${msg.author.displayName} (@${msg.author.username})`
    : msg.author.displayName;

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
