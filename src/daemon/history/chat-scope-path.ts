import type { Envelope } from "../../envelope/types.js";
import type { SessionFile } from "./types.js";
import { parseAddress } from "../../adapters/types.js";

export const DEFAULT_HISTORY_CHAT_DIR = "_no_chat";

export function normalizeHistoryChatDir(chatId?: string | null): string {
  if (typeof chatId !== "string") return DEFAULT_HISTORY_CHAT_DIR;
  const trimmed = chatId.trim();
  if (!trimmed) return DEFAULT_HISTORY_CHAT_DIR;
  const encoded = encodeURIComponent(trimmed);
  if (!encoded || encoded === "." || encoded === "..") {
    return DEFAULT_HISTORY_CHAT_DIR;
  }
  return encoded;
}

export function resolveEnvelopeChatId(envelope: Envelope): string | null {
  const fromChatId = extractChatIdFromAddress(envelope.from);
  if (fromChatId) return fromChatId;

  const toChatId = extractChatIdFromAddress(envelope.to);
  if (toChatId) return toChatId;

  const metadata = envelope.metadata as Record<string, unknown> | undefined;
  if (metadata && typeof metadata.chatScope === "string" && metadata.chatScope.trim().length > 0) {
    return metadata.chatScope.trim();
  }

  return null;
}

export function inferSessionChatId(session: SessionFile): string | null {
  for (const event of session.events) {
    if (event.type !== "envelope-created") continue;
    const chatId = resolveEnvelopeChatId(event.envelope);
    if (chatId) return chatId;
  }
  return null;
}

function extractChatIdFromAddress(address: string): string | null {
  try {
    const parsed = parseAddress(address);
    if (parsed.type === "channel" && parsed.chatId.trim().length > 0) {
      return parsed.chatId.trim();
    }
  } catch {
    // Ignore malformed addresses in historical payloads.
  }
  return null;
}
