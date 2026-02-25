import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

import type {
  ChatAdapter,
  ChannelCommand,
  ChannelCommandHandler,
  ChannelCommandResponse,
  ChannelMessage,
  ChannelMessageHandler,
  MessageContent,
  SendMessageOptions,
} from "./types.js";
import { detectAttachmentType } from "./types.js";
import { getHiBossPaths } from "../shared/hiboss-paths.js";
import { WeChatPadProWebhookHub } from "./wechatpadpro/webhook-hub.js";

type AdapterConfig = {
  authKey: string;
  baseUrl: string;
  webhookPublicBaseUrl: string;
  webhookListenHost: string;
  webhookListenPort: number;
  webhookSecret?: string;
  includeSelfMessage: boolean;
};

type NormalizedWebhookMessage = {
  id?: string;
  msgType?: number;
  chatId: string;
  authorId: string;
  displayName: string;
  text?: string;
  timestampMs: number;
  mediaCandidates: Array<{ source: string; filename?: string }>;
  raw: unknown;
};

const MESSAGE_TYPE_FILTERS = ["1", "3", "34", "43", "47", "49", "10000"];
const COMMAND_REGEX = /^\/([a-z][a-z0-9-]*)(?:\s+(.*))?$/i;
const DEFAULT_TEXT_CHUNK_SIZE = 1800;
const DEDUPE_TTL_MS = 5 * 60_000;

function parseAdapterConfig(adapterToken: string): AdapterConfig {
  const trimmed = adapterToken.trim();
  if (!trimmed) throw new Error("Invalid wechatpadpro adapter token: empty token");

  let tokenRaw = trimmed;
  let tokenObj: Record<string, unknown> = {};
  if (trimmed.startsWith("{")) {
    try {
      tokenObj = JSON.parse(trimmed) as Record<string, unknown>;
      tokenRaw = String(tokenObj.authKey ?? "").trim();
    } catch {
      throw new Error("Invalid wechatpadpro adapter token: expected valid JSON");
    }
  }

  const authKey = tokenRaw || String(tokenObj.authKey ?? "").trim();
  if (!authKey) throw new Error("Invalid wechatpadpro adapter token: missing authKey");

  const baseUrlRaw = String(
    tokenObj.baseUrl ??
      process.env.HIBOSS_WECHATPADPRO_BASE_URL ??
      "http://127.0.0.1:11238"
  ).trim();

  const listenHost = String(
    tokenObj.webhookListenHost ??
      process.env.HIBOSS_WECHATPADPRO_WEBHOOK_LISTEN_HOST ??
      "127.0.0.1"
  ).trim();
  const listenPortRaw = Number(
    tokenObj.webhookListenPort ??
      process.env.HIBOSS_WECHATPADPRO_WEBHOOK_LISTEN_PORT ??
      "18080"
  );
  const listenPort = Number.isFinite(listenPortRaw) && listenPortRaw > 0 ? Math.trunc(listenPortRaw) : 18080;

  const defaultPublicBaseUrl = `http://${listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost}:${listenPort}`;
  const webhookPublicBaseUrl = String(
    tokenObj.webhookPublicBaseUrl ??
      process.env.HIBOSS_WECHATPADPRO_WEBHOOK_PUBLIC_BASE_URL ??
      defaultPublicBaseUrl
  ).trim();
  const webhookSecret = String(tokenObj.webhookSecret ?? process.env.HIBOSS_WECHATPADPRO_WEBHOOK_SECRET ?? "").trim();
  const includeSelfRaw = String(
    tokenObj.includeSelfMessage ?? process.env.HIBOSS_WECHATPADPRO_WEBHOOK_INCLUDE_SELF ?? "true"
  ).trim();

  return {
    authKey,
    baseUrl: baseUrlRaw.replace(/\/+$/, ""),
    webhookPublicBaseUrl: webhookPublicBaseUrl.replace(/\/+$/, ""),
    webhookListenHost: listenHost,
    webhookListenPort: listenPort,
    webhookSecret: webhookSecret || undefined,
    includeSelfMessage: includeSelfRaw.toLowerCase() !== "false",
  };
}

function splitText(text: string, limit = DEFAULT_TEXT_CHUNK_SIZE): string[] {
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    out.push(remaining.slice(0, limit));
    remaining = remaining.slice(limit);
  }
  if (remaining.length > 0) out.push(remaining);
  return out.length > 0 ? out : [""];
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function normalizeWebhookMessage(payload: unknown): NormalizedWebhookMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const msg = root.message && typeof root.message === "object" ? (root.message as Record<string, unknown>) : root;

  const msgType = pickNumber(msg, ["msgType", "type"]);
  const fromUser = pickString(msg, ["fromUserName", "fromUser", "fromWxid", "senderWxid", "sender"]);
  const toUser = pickString(msg, ["toUserName", "toUser", "toWxid"]);
  const roomId = pickString(msg, ["chatId", "roomId", "talker", "conversationId"]);
  const rawContent = pickString(msg, ["content", "text", "msg"]) ?? "";
  const id = pickString(msg, ["msgId", "messageId", "newMsgId", "msg_id", "svrId", "id"]);
  const tsRaw = pickNumber(msg, ["timestamp", "time", "createTime"]);
  const timestampMs = tsRaw ? (tsRaw > 1_000_000_000_000 ? tsRaw : tsRaw * 1000) : Date.now();

  let chatId = roomId;
  if (!chatId && fromUser?.includes("@chatroom")) {
    chatId = fromUser;
  }
  if (!chatId) chatId = fromUser ?? toUser;
  if (!chatId) return null;

  let authorId =
    pickString(msg, ["realFromUserName", "senderWxid", "fromWxid", "fromUserName", "fromUser"]) ?? chatId;
  let text = rawContent;
  if (chatId.includes("@chatroom")) {
    const m = /^([a-zA-Z0-9_@-]+):\n([\s\S]*)$/.exec(rawContent);
    if (m) {
      authorId = m[1] ?? authorId;
      text = m[2] ?? rawContent;
    }
  }
  const displayName = pickString(msg, ["nickname", "fromNickName", "senderNickName"]) ?? authorId;

  const mediaCandidates: Array<{ source: string; filename?: string }> = [];
  for (const key of ["filePath", "fileUrl", "imageUrl", "imgUrl", "videoUrl", "voiceUrl", "thumbUrl", "url"]) {
    const value = msg[key];
    if (typeof value === "string" && value.trim()) {
      mediaCandidates.push({ source: value.trim() });
    }
  }

  return {
    id,
    msgType: msgType ?? undefined,
    chatId,
    authorId,
    displayName,
    text,
    timestampMs,
    mediaCandidates,
    raw: payload,
  };
}

export class WeChatPadProAdapter implements ChatAdapter {
  readonly platform = "wechatpadpro";
  private readonly config: AdapterConfig;
  private readonly mediaDir: string;
  private readonly routePath: string;
  private handlers: ChannelMessageHandler[] = [];
  private commandHandlers: ChannelCommandHandler[] = [];
  private started = false;
  private dedupeCache = new Map<string, number>();

  constructor(adapterToken: string) {
    this.config = parseAdapterConfig(adapterToken);
    this.mediaDir = getHiBossPaths().mediaDir;
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.routePath = `/webhook/wechatpadpro/${crypto.createHash("sha256").update(this.config.authKey).digest("hex").slice(0, 24)}`;
  }

  async start(): Promise<void> {
    if (this.started) return;
    WeChatPadProWebhookHub.configure(this.config.webhookListenHost, this.config.webhookListenPort);
    await WeChatPadProWebhookHub.ensureStarted();
    WeChatPadProWebhookHub.registerRoute(this.routePath, {
      secret: this.config.webhookSecret,
      onPayload: async (payload) => this.handleWebhookPayload(payload),
    });
    await this.configureWebhook();
    this.started = true;
  }

  async stop(): Promise<void> {
    WeChatPadProWebhookHub.unregisterRoute(this.routePath);
    this.started = false;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.handlers.push(handler);
  }

  onCommand(handler: ChannelCommandHandler): void {
    this.commandHandlers.push(handler);
  }

  async sendMessage(chatId: string, content: MessageContent, _options: SendMessageOptions = {}): Promise<void> {
    const text = content.text?.trim();
    if (text) {
      for (const chunk of splitText(text)) {
        await this.sendText(chatId, chunk);
      }
    }

    for (const attachment of content.attachments ?? []) {
      const type = detectAttachmentType(attachment);
      if (type === "image") {
        await this.sendImage(chatId, attachment.source);
      } else if (type === "audio") {
        await this.sendVoice(chatId, attachment.source, attachment.filename);
      } else if (type === "video") {
        await this.sendVideo(chatId, attachment.source, attachment.filename);
      } else {
        await this.sendFile(chatId, attachment.source, attachment.filename);
      }
    }
  }

  private async handleWebhookPayload(payload: unknown): Promise<void> {
    const normalized = normalizeWebhookMessage(payload);
    if (!normalized) return;

    const dedupeKey = this.computeDedupeKey(normalized);
    if (this.isDuplicate(dedupeKey, normalized.timestampMs)) return;

    const commandMatch = normalized.text ? COMMAND_REGEX.exec(normalized.text.trim()) : null;
    if (commandMatch) {
      await this.dispatchCommand(normalized, commandMatch[1]!.toLowerCase(), (commandMatch[2] ?? "").trim());
      return;
    }

    const attachments = await this.resolveIncomingAttachments(normalized.mediaCandidates);
    const message: ChannelMessage = {
      id: normalized.id ?? crypto.randomUUID(),
      platform: this.platform,
      author: {
        id: normalized.authorId,
        username: normalized.authorId,
        displayName: normalized.displayName,
      },
      chat: {
        id: normalized.chatId,
      },
      content: {
        text: normalized.text,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      raw: normalized.raw,
    };

    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  private async dispatchCommand(
    normalized: NormalizedWebhookMessage,
    commandName: string,
    args: string
  ): Promise<void> {
    const command: ChannelCommand = {
      command: commandName,
      args,
      adapterType: this.platform,
      chatId: normalized.chatId,
      authorId: normalized.authorId,
      authorUsername: normalized.authorId,
      messageId: normalized.id,
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

    if (!response) return;
    await this.sendMessage(normalized.chatId, {
      text: response.text,
      attachments: response.attachments,
    });
  }

  private computeDedupeKey(msg: NormalizedWebhookMessage): string {
    if (msg.id) return `id:${msg.id}`;
    const bucket = Math.floor(msg.timestampMs / 30_000);
    const text = msg.text?.trim() ?? "";
    const hash = crypto
      .createHash("sha256")
      .update(`${msg.chatId}\n${msg.authorId}\n${msg.msgType ?? 0}\n${bucket}\n${text}`)
      .digest("hex");
    return `hash:${hash}`;
  }

  private isDuplicate(key: string, now: number): boolean {
    for (const [k, expiresAt] of this.dedupeCache) {
      if (expiresAt <= now) this.dedupeCache.delete(k);
    }
    const expiresAt = this.dedupeCache.get(key);
    if (typeof expiresAt === "number" && expiresAt > now) return true;
    this.dedupeCache.set(key, now + DEDUPE_TTL_MS);
    return false;
  }

  private async resolveIncomingAttachments(
    candidates: Array<{ source: string; filename?: string }>
  ): Promise<Array<{ source: string; filename?: string }>> {
    const out: Array<{ source: string; filename?: string }> = [];
    for (const candidate of candidates) {
      const source = candidate.source;
      if (/^https?:\/\//i.test(source)) {
        try {
          const downloaded = await this.downloadRemoteFile(source, candidate.filename);
          out.push(downloaded);
        } catch {
          // Keep original URL when download fails.
          out.push({ source, filename: candidate.filename });
        }
      } else if (fs.existsSync(source)) {
        out.push({ source, filename: candidate.filename ?? path.basename(source) });
      }
    }
    return out;
  }

  private async downloadRemoteFile(url: string, filename?: string): Promise<{ source: string; filename?: string }> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const arr = await res.arrayBuffer();
    const buf = Buffer.from(arr);
    const parsed = new URL(url);
    const inferredName = filename || path.basename(parsed.pathname) || `wechatpadpro-${Date.now()}.bin`;
    const localPath = path.join(this.mediaDir, inferredName);
    fs.writeFileSync(localPath, buf);
    return { source: localPath, filename: inferredName };
  }

  private async configureWebhook(): Promise<void> {
    const callbackUrl = `${this.config.webhookPublicBaseUrl}${this.routePath}`;
    await this.apiPostJson("/webhook/Config", {
      url: callbackUrl,
      secret: this.config.webhookSecret ?? "",
      enabled: true,
      timeout: 10,
      retryCount: 3,
      messageTypes: MESSAGE_TYPE_FILTERS,
      includeSelfMessage: this.config.includeSelfMessage,
    });
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    await this.apiPostJson("/message/SendTextMessage", {
      MsgItem: [
        {
          ToUserName: chatId,
          MsgType: 1,
          TextContent: text,
        },
      ],
    });
  }

  private async sendImage(chatId: string, source: string): Promise<void> {
    const buf = /^https?:\/\//i.test(source) ? Buffer.from(await (await fetch(source)).arrayBuffer()) : fs.readFileSync(source);
    await this.apiPostJson("/message/SendImageMessage", {
      MsgItem: [
        {
          ToUserName: chatId,
          MsgType: 2,
          ImageContent: buf.toString("base64"),
        },
      ],
    });
  }

  private async sendFile(chatId: string, source: string, filename?: string): Promise<void> {
    await this.apiPostMultipart("/message/SendFileMessage", {
      ToUserName: chatId,
      FileName: filename ?? path.basename(source),
    }, source, filename ?? path.basename(source));
  }

  private async sendVoice(chatId: string, source: string, filename?: string): Promise<void> {
    await this.apiPostMultipart("/message/SendVoice", {
      ToUserName: chatId,
      VoiceSecond: "1",
      VoiceFormat: "0",
    }, source, filename ?? path.basename(source));
  }

  private async sendVideo(chatId: string, source: string, filename?: string): Promise<void> {
    await this.apiPostMultipart("/message/SendVideoMsg", {
      ToWxid: chatId,
      PlayLength: "1",
    }, source, filename ?? path.basename(source));
  }

  private async apiPostJson(pathname: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.apiRequest(pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response;
  }

  private async apiPostMultipart(
    pathname: string,
    fields: Record<string, string>,
    filePath: string,
    fileName: string
  ): Promise<unknown> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      form.append(k, v);
    }
    const data = /^https?:\/\//i.test(filePath)
      ? Buffer.from(await (await fetch(filePath)).arrayBuffer())
      : fs.readFileSync(filePath);
    form.append("file", new Blob([data]), fileName);
    const response = await this.apiRequest(pathname, {
      method: "POST",
      body: form,
    });
    return response;
  }

  private async apiRequest(pathname: string, init: RequestInit): Promise<unknown> {
    const url = new URL(pathname, `${this.config.baseUrl}/`);
    url.searchParams.set("key", this.config.authKey);
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`WeChatPadPro API ${pathname} failed (${res.status}): ${text}`);
    }
    let decoded: unknown = text;
    try {
      decoded = JSON.parse(text);
    } catch {
      // Keep plain-text response.
    }
    if (decoded && typeof decoded === "object") {
      const code = (decoded as Record<string, unknown>).Code;
      if (typeof code === "number" && code !== 0 && code !== 200) {
        const message =
          String((decoded as Record<string, unknown>).Text ?? (decoded as Record<string, unknown>).msg ?? "unknown");
        throw new Error(`WeChatPadPro API ${pathname} rejected: [${code}] ${message}`);
      }
    }
    return decoded;
  }
}
