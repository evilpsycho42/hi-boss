import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { resolveToken } from "../token.js";
import type { Envelope } from "../../envelope/types.js";
import { formatEnvelopeInstruction } from "../instructions/format-envelope.js";
import { extractTelegramFileId, normalizeAttachmentSource, resolveText } from "./envelope-input.js";
import { formatShortId } from "../../shared/id-format.js";

interface SendEnvelopeResult {
  id: string;
}

interface ListEnvelopesResult {
  envelopes: Envelope[];
}

export interface SendEnvelopeOptions {
  to: string;
  token?: string;
  text?: string;
  textFile?: string;
  attachment?: string[];
  deliverAt?: string;
  parseMode?: string;
  replyTo?: string;
}

export interface ListEnvelopesOptions {
  token?: string;
  to?: string;
  from?: string;
  status: "pending" | "done";
  limit?: number;
}

/**
 * Send an envelope.
 */
export async function sendEnvelope(options: SendEnvelopeOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const text = await resolveText(options.text, options.textFile);
    const parseMode = options.parseMode?.trim();
    if (parseMode && parseMode !== "plain" && parseMode !== "markdownv2" && parseMode !== "html") {
      throw new Error("Invalid --parse-mode (expected plain, markdownv2, or html)");
    }
    const result = await client.call<SendEnvelopeResult>("envelope.send", {
      token,
      to: options.to,
      text,
      attachments: options.attachment?.map((source) => {
        const telegramFileId = extractTelegramFileId(source);
        return {
          source: normalizeAttachmentSource(source),
          ...(telegramFileId ? { telegramFileId } : {}),
        };
      }),
      deliverAt: options.deliverAt,
      parseMode,
      replyToMessageId: options.replyTo,
    });

    console.log(`id: ${formatShortId(result.id)}`);
  } catch (err) {
    const e = err as Error & { code?: number; data?: unknown };
    console.error("error:", e.message);

    const data = e.data;
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      if (typeof d.envelopeId === "string" && d.envelopeId.trim()) {
        console.error(`envelope-id: ${formatShortId(d.envelopeId.trim())}`);
      }
      if (typeof d.adapterType === "string") {
        console.error(`adapter-type: ${d.adapterType}`);
      }
      if (typeof d.chatId === "string") {
        console.error(`chat-id: ${d.chatId}`);
      }
      if (typeof d.parseMode === "string") {
        console.error(`parse-mode: ${d.parseMode}`);
      }
      if (typeof d.replyToMessageId === "string" && d.replyToMessageId.trim()) {
        console.error(`reply-to-channel-message-id: ${d.replyToMessageId.trim()}`);
      }

      const adapterError = d.adapterError;
      if (adapterError && typeof adapterError === "object") {
        const ae = adapterError as Record<string, unknown>;
        if (typeof ae.summary === "string") {
          console.error(`adapter-error: ${ae.summary}`);
        }
        if (typeof ae.hint === "string" && ae.hint.trim()) {
          console.error(`hint: ${ae.hint.trim()}`);
        }
        const telegram = ae.telegram;
        if (telegram && typeof telegram === "object") {
          const t = telegram as Record<string, unknown>;
          if (typeof t.errorCode === "number") {
            console.error(`telegram-error-code: ${t.errorCode}`);
          }
          if (typeof t.description === "string") {
            console.error(`telegram-description: ${t.description}`);
          }
        }
      }
    }
    process.exit(1);
  }
}

/**
 * List envelopes.
 */
export async function listEnvelopes(options: ListEnvelopesOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const hasTo = typeof options.to === "string" && options.to.trim();
    const hasFrom = typeof options.from === "string" && options.from.trim();
    if ((hasTo && hasFrom) || (!hasTo && !hasFrom)) {
      throw new Error("Provide exactly one of --to or --from");
    }

    if (!options.status) {
      throw new Error("Missing --status (pending or done)");
    }

    const result = await client.call<ListEnvelopesResult>("envelope.list", {
      token,
      to: options.to,
      from: options.from,
      status: options.status,
      limit: options.limit,
    });

    if (result.envelopes.length === 0) {
      console.log("no-envelopes: true");
      return;
    }

    for (const env of result.envelopes) {
      console.log(formatEnvelopeInstruction(env));
      console.log();
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}
