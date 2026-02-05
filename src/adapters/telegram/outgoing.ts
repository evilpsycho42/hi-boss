import * as fs from "fs";
import * as path from "path";
import type { Attachment, MessageContent, SendMessageOptions } from "../types.js";
import { detectAttachmentType } from "../types.js";
import { parseTelegramMessageId } from "../../shared/telegram-message-id.js";
import {
  isReplyToMessageNotFound,
  splitTextForTelegram,
  TELEGRAM_MAX_CAPTION_CHARS,
  TELEGRAM_MAX_TEXT_CHARS,
  toTelegramParseMode,
} from "./shared.js";

type TelegramOutgoingApi = {
  sendMessage: (chatId: string, text: string, extra?: unknown) => Promise<unknown>;
  sendPhoto: (chatId: string, source: unknown, extra?: unknown) => Promise<unknown>;
  sendVideo: (chatId: string, source: unknown, extra?: unknown) => Promise<unknown>;
  sendAudio: (chatId: string, source: unknown, extra?: unknown) => Promise<unknown>;
  sendDocument: (chatId: string, source: unknown, extra?: unknown) => Promise<unknown>;
  callApi: (method: string, payload: unknown) => Promise<unknown>;
};

function resolveUploadFilename(candidate: string | undefined, fallbackPath: string): string {
  const trimmed = candidate?.trim();
  if (trimmed) return path.basename(trimmed);
  return path.basename(fallbackPath);
}

function resolveSource(attachment: Attachment): string | { source: string; filename?: string } {
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
    return {
      source: resolvedPath,
      filename: resolveUploadFilename(attachment.filename, resolvedPath),
    };
  }

  return source;
}

function resolveSourceForMediaGroup(attachment: Attachment): string | { source: string; filename?: string } {
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
    return {
      source: resolvedPath,
      filename: resolveUploadFilename(attachment.filename, resolvedPath),
    };
  }

  // Fallback: treat as Telegram file_id
  return source;
}

async function sendTextMessages(telegram: TelegramOutgoingApi, chatId: string, text: string, options: SendMessageOptions = {}): Promise<void> {
  const telegramParseMode = toTelegramParseMode(options.parseMode);
  const replyParameters =
    options.replyToMessageId && options.replyToMessageId.trim()
      ? {
          message_id: parseTelegramMessageId(options.replyToMessageId, "reply-to-channel-message-id"),
        }
      : undefined;

  const chunks = splitTextForTelegram(text, TELEGRAM_MAX_TEXT_CHARS);

  for (let i = 0; i < chunks.length; i++) {
    const extra = {
      parse_mode: telegramParseMode,
      ...(i === 0 && replyParameters ? { reply_parameters: replyParameters } : {}),
    } as unknown as Record<string, unknown>;

    try {
      await telegram.sendMessage(chatId, chunks[i], extra as never);
    } catch (err) {
      // Telegram returns 400 "message to be replied not found" when reply_parameters.message_id is invalid
      // (deleted message, wrong id, etc). Retry once without reply parameters so delivery doesn't get stuck.
      if (i === 0 && replyParameters && isReplyToMessageNotFound(err)) {
        const fallback = { ...extra };
        delete fallback.reply_parameters;
        await telegram.sendMessage(chatId, chunks[i], fallback as never);
        continue;
      }
      throw err;
    }
  }
}

async function sendAttachment(
  telegram: TelegramOutgoingApi,
  chatId: string,
  attachment: Attachment,
  caption?: string,
  options: SendMessageOptions = {}
): Promise<void> {
  const type = detectAttachmentType(attachment);
  const source = resolveSource(attachment);
  const telegramParseMode = toTelegramParseMode(options.parseMode);
  const replyParameters =
    options.replyToMessageId && options.replyToMessageId.trim()
      ? {
          message_id: parseTelegramMessageId(options.replyToMessageId, "reply-to-channel-message-id"),
        }
      : undefined;

  const safeCaption =
    typeof caption === "string" && caption.length > TELEGRAM_MAX_CAPTION_CHARS
      ? caption.slice(0, TELEGRAM_MAX_CAPTION_CHARS)
      : caption;

  const extra: Record<string, unknown> = {
    ...(safeCaption ? { caption: safeCaption } : {}),
    ...(telegramParseMode ? { parse_mode: telegramParseMode } : {}),
    ...(replyParameters ? { reply_parameters: replyParameters } : {}),
  };

  const fallbackExtra = replyParameters
    ? (() => {
        const fallback = { ...extra };
        delete fallback.reply_parameters;
        return fallback;
      })()
    : undefined;

  switch (type) {
    case "image":
      try {
        await telegram.sendPhoto(chatId, source, extra as never);
      } catch (err) {
        if (fallbackExtra && isReplyToMessageNotFound(err)) {
          await telegram.sendPhoto(chatId, source, fallbackExtra as never);
          break;
        }
        throw err;
      }
      break;
    case "video":
      try {
        await telegram.sendVideo(chatId, source, extra as never);
      } catch (err) {
        if (fallbackExtra && isReplyToMessageNotFound(err)) {
          await telegram.sendVideo(chatId, source, fallbackExtra as never);
          break;
        }
        throw err;
      }
      break;
    case "audio":
      try {
        await telegram.sendAudio(chatId, source, extra as never);
      } catch (err) {
        if (fallbackExtra && isReplyToMessageNotFound(err)) {
          await telegram.sendAudio(chatId, source, fallbackExtra as never);
          break;
        }
        throw err;
      }
      break;
    case "file":
      try {
        await telegram.sendDocument(chatId, source, extra as never);
      } catch (err) {
        if (fallbackExtra && isReplyToMessageNotFound(err)) {
          await telegram.sendDocument(chatId, source, fallbackExtra as never);
          break;
        }
        throw err;
      }
      break;
  }
}

export async function sendTelegramMessage(
  telegram: TelegramOutgoingApi,
  chatId: string,
  content: MessageContent,
  options: SendMessageOptions = {}
): Promise<void> {
  const { text, attachments } = content;
  const telegramParseMode = toTelegramParseMode(options.parseMode);
  const hasText = typeof text === "string" && text.trim().length > 0;
  const captionTooLong = hasText && text.length > TELEGRAM_MAX_CAPTION_CHARS;

  const replyParameters =
    options.replyToMessageId && options.replyToMessageId.trim()
      ? {
          message_id: parseTelegramMessageId(options.replyToMessageId, "reply-to-channel-message-id"),
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
      // Telegram captions are limited. If the text is too long to be a caption,
      // send it separately as a normal message and keep the media album un-captioned.
      if (hasText && captionTooLong) {
        await sendTextMessages(telegram, chatId, text, {
          parseMode: options.parseMode,
          replyToMessageId: options.replyToMessageId,
        });
      }

      const chunks: Attachment[][] = [];
      for (let i = 0; i < attachments.length; i += 10) {
        chunks.push(attachments.slice(i, i + 10));
      }

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        const media = chunk.map((attachment, idx) => {
          const type = detectAttachmentType(attachment);
          const mediaType =
            type === "image" ? "photo" : type === "video" ? "video" : type === "audio" ? "audio" : "document";

          const mediaSource = resolveSourceForMediaGroup(attachment) as unknown;
          const isFirstItemOverall = chunkIndex === 0 && idx === 0;
          const caption = isFirstItemOverall && hasText && !captionTooLong ? text : undefined;

          const item: Record<string, unknown> = { type: mediaType, media: mediaSource };
          if (caption) {
            item.caption = caption;
            if (telegramParseMode) item.parse_mode = telegramParseMode;
          }
          return item;
        });

        const extra: Record<string, unknown> = {};
        if (chunkIndex === 0 && replyParameters && !(hasText && captionTooLong)) {
          extra.reply_parameters = replyParameters;
        }

        try {
          await telegram.callApi("sendMediaGroup", {
            chat_id: chatId,
            media: media as unknown as never,
            ...extra,
          } as unknown as never);
        } catch (err) {
          if (chunkIndex === 0 && extra.reply_parameters && isReplyToMessageNotFound(err)) {
            const fallback = { ...extra };
            delete fallback.reply_parameters;
            await telegram.callApi("sendMediaGroup", {
              chat_id: chatId,
              media: media as unknown as never,
              ...fallback,
            } as unknown as never);
            continue;
          }
          throw err;
        }
      }

      // If we used the message text as a caption, do not send a separate text message.
      // If there were more than 10 items and we chunked, the caption is still attached to the first chunk.
      return;
    }
  }

  let replied = false;

  if (attachments?.length) {
    // For a single attachment, we normally use the text as the caption.
    // Telegram enforces a caption limit, so fall back to sending the text separately when needed.
    if (attachments.length === 1 && hasText && captionTooLong) {
      await sendTextMessages(telegram, chatId, text, {
        parseMode: options.parseMode,
        replyToMessageId: options.replyToMessageId,
      });

      await sendAttachment(telegram, chatId, attachments[0], undefined, { parseMode: options.parseMode });
      return;
    }

    for (const attachment of attachments) {
      const isFirst = !replied;
      const caption = attachments.length === 1 ? text : undefined;
      await sendAttachment(telegram, chatId, attachment, caption, {
        parseMode: options.parseMode,
        replyToMessageId: isFirst ? options.replyToMessageId : undefined,
      });
      replied = true;
    }

    if (attachments.length > 1 && text) {
      await sendTextMessages(telegram, chatId, text, { parseMode: options.parseMode });
    }
  } else if (text) {
    await sendTextMessages(telegram, chatId, text, {
      parseMode: options.parseMode,
      replyToMessageId: options.replyToMessageId,
    });
  }
}
