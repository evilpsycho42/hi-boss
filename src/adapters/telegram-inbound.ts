import type { Context } from "telegraf";
import type { Message as TelegramMessage } from "telegraf/types";
import type { Telegraf } from "telegraf";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Attachment, ChannelMessage } from "./types.js";

type TextContext = Context & { message: TelegramMessage.TextMessage };
type PhotoContext = Context & { message: TelegramMessage.PhotoMessage };
type VideoContext = Context & { message: TelegramMessage.VideoMessage };
type DocumentContext = Context & { message: TelegramMessage.DocumentMessage };
type VoiceContext = Context & { message: TelegramMessage.VoiceMessage };
type AudioContext = Context & { message: TelegramMessage.AudioMessage };

export type MessageContext =
  | TextContext
  | PhotoContext
  | VideoContext
  | DocumentContext
  | VoiceContext
  | AudioContext;

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[...truncated...]\n";
}

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

  const author =
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
    author: author && author.displayName ? author : undefined,
    text: text ? truncateText(text, 1200) : undefined,
  };
}

function extractText(msg: MessageContext["message"]): string | undefined {
  if ("text" in msg) return msg.text;
  if ("caption" in msg) return msg.caption;
  return undefined;
}

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

async function getTelegramAttachment(params: {
  bot: Telegraf<Context>;
  mediaDir: string;
  fileId: string;
  preferredFilename?: string;
}): Promise<Attachment> {
  const file = await params.bot.telegram.getFile(params.fileId);
  const derivedFilename = file.file_path ? path.posix.basename(file.file_path) : undefined;
  const filename = params.preferredFilename ?? derivedFilename;

  // Derive extension from file_path (e.g., "photos/file_123.jpg" -> "jpg")
  const ext = file.file_path ? path.extname(file.file_path).slice(1) || "bin" : "bin";

  // Get download URL and fetch the file
  const fileUrl = await params.bot.telegram.getFileLink(params.fileId);
  const response = await fetch(fileUrl.toString());
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  // Ensure media directory exists
  if (!fs.existsSync(params.mediaDir)) {
    fs.mkdirSync(params.mediaDir, { recursive: true });
  }

  // Use original filename when available, with incremental suffix for duplicates
  const targetFilename = filename || `file_${crypto.randomUUID()}.${ext}`;
  const localPath = getUniqueFilePath(params.mediaDir, targetFilename);
  fs.writeFileSync(localPath, buffer);

  return {
    source: localPath,
    filename,
    telegramFileId: params.fileId,
  };
}

async function extractAttachments(ctx: MessageContext, bot: Telegraf<Context>, mediaDir: string): Promise<Attachment[]> {
  const msg = ctx.message;
  const attachments: Attachment[] = [];

  if ("photo" in msg && msg.photo) {
    const photo = msg.photo[msg.photo.length - 1];
    attachments.push(await getTelegramAttachment({ bot, mediaDir, fileId: photo.file_id }));
  }

  if ("video" in msg && msg.video) {
    attachments.push(
      await getTelegramAttachment({ bot, mediaDir, fileId: msg.video.file_id, preferredFilename: msg.video.file_name })
    );
  }

  if ("document" in msg && msg.document) {
    attachments.push(
      await getTelegramAttachment({
        bot,
        mediaDir,
        fileId: msg.document.file_id,
        preferredFilename: msg.document.file_name,
      })
    );
  }

  if ("voice" in msg && msg.voice) {
    attachments.push(
      await getTelegramAttachment({
        bot,
        mediaDir,
        fileId: msg.voice.file_id,
        preferredFilename: `voice_${Date.now()}.oga`,
      })
    );
  }

  if ("audio" in msg && msg.audio) {
    attachments.push(
      await getTelegramAttachment({ bot, mediaDir, fileId: msg.audio.file_id, preferredFilename: msg.audio.file_name })
    );
  }

  return attachments;
}

export async function buildTelegramChannelMessage(params: {
  ctx: MessageContext;
  bot: Telegraf<Context>;
  platform: string;
  mediaDir: string;
}): Promise<ChannelMessage> {
  const telegramMsg = params.ctx.message;
  const chat = params.ctx.chat!;
  const from = params.ctx.from!;

  const attachments = await extractAttachments(params.ctx, params.bot, params.mediaDir);
  const text = extractText(telegramMsg);
  const inReplyTo = extractInReplyTo(telegramMsg);

  const chatName = chat.type === "group" || chat.type === "supergroup" ? chat.title : undefined;

  return {
    id: String(telegramMsg.message_id),
    platform: params.platform,
    author: {
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

