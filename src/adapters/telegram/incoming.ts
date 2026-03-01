import type { Context } from "telegraf";
import type { Message as TelegramMessage } from "telegraf/types";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Attachment, ChannelMessage } from "../types.js";
import { truncateText } from "./shared.js";

type TextContext = Context & { message: TelegramMessage.TextMessage };
type PhotoContext = Context & { message: TelegramMessage.PhotoMessage };
type VideoContext = Context & { message: TelegramMessage.VideoMessage };
type DocumentContext = Context & { message: TelegramMessage.DocumentMessage };
type VoiceContext = Context & { message: TelegramMessage.VoiceMessage };
type AudioContext = Context & { message: TelegramMessage.AudioMessage };
export type MessageContext = TextContext | PhotoContext | VideoContext | DocumentContext | VoiceContext | AudioContext;

type TelegramIncomingApi = {
  getFile: (fileId: string) => Promise<{ file_path?: string }>;
  getFileLink: (fileId: string) => Promise<{ toString: () => string }>;
};

function extractInReplyTo(msg: MessageContext["message"]): ChannelMessage["inReplyTo"] | undefined {
  const raw = msg as unknown as { reply_to_message?: unknown };
  const reply = raw.reply_to_message;
  if (!reply || typeof reply !== "object") return undefined;

  const replyMsg = reply as {
    message_id?: number;
    from?: { id?: number; username?: string; first_name?: string };
    text?: string;
    caption?: string;
  };

  if (typeof replyMsg.message_id !== "number") return undefined;

  const channelUser =
    replyMsg.from && typeof replyMsg.from === "object" && typeof replyMsg.from.id === "number"
      ? {
          id: String(replyMsg.from.id),
          username: typeof replyMsg.from.username === "string" ? replyMsg.from.username : undefined,
          displayName: typeof replyMsg.from.first_name === "string" ? replyMsg.from.first_name : "",
        }
      : undefined;

  const text =
    typeof replyMsg.text === "string"
      ? replyMsg.text
      : typeof replyMsg.caption === "string"
        ? replyMsg.caption
        : undefined;

  return {
    channelMessageId: String(replyMsg.message_id),
    channelUser: channelUser && channelUser.displayName ? channelUser : undefined,
    text: text ? truncateText(text, 1200) : undefined,
  };
}

function extractText(msg: MessageContext["message"]): string | undefined {
  if ("text" in msg) return msg.text;
  if ("caption" in msg) return msg.caption;
  return undefined;
}

/**
 * Get a unique file path in the given directory, adding incremental suffix for duplicates.
 */
function getUniqueFilePath(dir: string, filename: string): string {
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
 * Downloads the file to ~/hiboss/media/ using the original filename when
 * available, with incremental suffix for duplicates. The original file_id
 * is preserved for efficient re-sending via Telegram API.
 *
 * When TELEGRAM_API_ROOT is set (Local Bot API Server), getFile returns an
 * absolute local path. In that case, the file is copied directly instead of
 * being downloaded via HTTP, avoiding timeouts for large files.
 */
async function getTelegramAttachment(
  telegram: TelegramIncomingApi,
  mediaDir: string,
  fileId: string,
  preferredFilename?: string
): Promise<Attachment> {
  const file = await telegram.getFile(fileId);
  const derivedFilename = file.file_path ? path.posix.basename(file.file_path) : undefined;
  const filename = preferredFilename ?? derivedFilename;

  // Derive extension from file_path (e.g., "photos/file_123.jpg" -> "jpg")
  const ext = file.file_path ? path.extname(file.file_path).slice(1) || "bin" : "bin";

  // Ensure media directory exists
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  const targetFilename = filename || `file_${crypto.randomUUID()}.${ext}`;
  const localPath = getUniqueFilePath(mediaDir, targetFilename);

  // Local Bot API Server: file_path is an absolute local path — copy directly
  if (file.file_path && path.isAbsolute(file.file_path) && fs.existsSync(file.file_path)) {
    fs.copyFileSync(file.file_path, localPath);
    return { source: localPath, filename, telegramFileId: fileId };
  }

  // Standard API: download via HTTP
  const fileUrl = await telegram.getFileLink(fileId);
  const response = await fetch(fileUrl.toString());
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  return {
    source: localPath,
    filename,
    telegramFileId: fileId,
  };
}

async function tryGetAttachment(
  telegram: TelegramIncomingApi,
  mediaDir: string,
  fileId: string,
  preferredFilename?: string
): Promise<Attachment | null> {
  try {
    return await getTelegramAttachment(telegram, mediaDir, fileId, preferredFilename);
  } catch (err) {
    const desc = err instanceof Error ? err.message : String(err);
    console.error(`[telegram] Failed to download attachment (${preferredFilename ?? fileId}): ${desc}`);
    return null;
  }
}

async function extractAttachments(telegram: TelegramIncomingApi, mediaDir: string, ctx: MessageContext): Promise<Attachment[]> {
  const msg = ctx.message;
  const attachments: Attachment[] = [];

  if ("photo" in msg && msg.photo) {
    const photo = msg.photo[msg.photo.length - 1];
    const att = await tryGetAttachment(telegram, mediaDir, photo.file_id);
    if (att) attachments.push(att);
  }

  if ("video" in msg && msg.video) {
    const att = await tryGetAttachment(telegram, mediaDir, msg.video.file_id, msg.video.file_name);
    if (att) attachments.push(att);
  }

  if ("document" in msg && msg.document) {
    const att = await tryGetAttachment(telegram, mediaDir, msg.document.file_id, msg.document.file_name);
    if (att) attachments.push(att);
  }

  if ("voice" in msg && msg.voice) {
    const att = await tryGetAttachment(telegram, mediaDir, msg.voice.file_id, `voice_${Date.now()}.oga`);
    if (att) attachments.push(att);
  }

  if ("audio" in msg && msg.audio) {
    const att = await tryGetAttachment(telegram, mediaDir, msg.audio.file_id, msg.audio.file_name);
    if (att) attachments.push(att);
  }

  return attachments;
}

export async function buildTelegramChannelMessage(params: {
  platform: string;
  telegram: TelegramIncomingApi;
  ctx: MessageContext;
  mediaDir: string;
}): Promise<ChannelMessage> {
  const telegramMsg = params.ctx.message;
  const chat = params.ctx.chat!;
  const from = params.ctx.from!;

  const attachments = await extractAttachments(params.telegram, params.mediaDir, params.ctx);
  const text = extractText(telegramMsg);
  const inReplyTo = extractInReplyTo(telegramMsg);

  const chatName = chat.type === "group" || chat.type === "supergroup" ? chat.title : undefined;

  return {
    id: String(telegramMsg.message_id),
    platform: params.platform,
    channelUser: {
      id: String(from.id),
      username: from.username,
      displayName: from.first_name,
    },
    inReplyTo,
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
