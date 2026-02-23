import type { ChannelCommand, ChannelCommandHandler, ChannelCommandResponse, TelegramInlineKeyboardButton } from "../adapters/types.js";
import { formatAgentAddress, formatChannelAddress } from "../adapters/types.js";
import type { AgentExecutor } from "../agent/executor.js";
import type { OneshotType } from "../envelope/types.js";
import { DEFAULT_AGENT_PERMISSION_LEVEL, DEFAULT_AGENT_PROVIDER, getDefaultRuntimeWorkspace } from "../shared/defaults.js";
import { logEvent, errorMessage } from "../shared/daemon-log.js";
import { DEFAULT_ID_PREFIX_LEN, formatShortId, isHexLower, normalizeIdPrefixInput } from "../shared/id-format.js";
import { formatUnixMsAsTimeZoneOffset } from "../shared/time.js";
import { resolveUiLocale } from "../shared/ui-locale.js";
import { getUiText } from "../shared/ui-text.js";
import type { HiBossDatabase, SessionListScope, AgentSessionRecord } from "./db/database.js";
import type { MessageRouter } from "./router/message-router.js";

type EnrichedChannelCommand = ChannelCommand & { agentName?: string };

type SessionsView = {
  scope: SessionListScope;
  page: number;
};

const SESSIONS_PAGE_SIZE = 10;
const SESSIONS_MAX_TOTAL = 100;
const SESSIONS_CALLBACK_PREFIX = "hiboss:sessions:";

const SESSION_SCOPE_VALUES: SessionListScope[] = ["current-chat", "my-chats", "agent-all"];

function isSessionScope(value: string): value is SessionListScope {
  return SESSION_SCOPE_VALUES.includes(value as SessionListScope);
}

function parseSessionsView(args: string | undefined): SessionsView {
  const raw = (args ?? "").trim();
  if (!raw) {
    return { scope: "current-chat", page: 1 };
  }

  let scope: SessionListScope = "current-chat";
  let page = 1;

  for (const token of raw.split(/\s+/).filter(Boolean)) {
    if (token.startsWith("tab=")) {
      const value = token.slice(4).trim();
      if (isSessionScope(value)) scope = value;
      continue;
    }
    if (token.startsWith("scope=")) {
      const value = token.slice(6).trim();
      if (isSessionScope(value)) scope = value;
      continue;
    }
    if (token.startsWith("page=")) {
      const maybe = Number(token.slice(5));
      if (Number.isFinite(maybe) && maybe > 0) page = Math.trunc(maybe);
      continue;
    }
    if (isSessionScope(token)) {
      scope = token;
      continue;
    }
    const maybe = Number(token);
    if (Number.isFinite(maybe) && maybe > 0) {
      page = Math.trunc(maybe);
    }
  }

  return { scope, page: Math.max(1, page) };
}

function buildSessionsKeyboard(params: {
  scope: SessionListScope;
  page: number;
  totalPages: number;
  locale: "en" | "zh-CN";
}): TelegramInlineKeyboardButton[][] {
  const tabLabels = params.locale === "zh-CN"
    ? {
        "current-chat": "当前聊天",
        "my-chats": "我的聊天",
        "agent-all": "该Agent全部",
      }
    : {
        "current-chat": "Current",
        "my-chats": "Mine",
        "agent-all": "Agent All",
      };

  const selectedPrefix = "● ";
  const tabRow: TelegramInlineKeyboardButton[] = SESSION_SCOPE_VALUES.map((scope) => ({
    text: `${params.scope === scope ? selectedPrefix : ""}${tabLabels[scope]}`,
    callbackData: `${SESSIONS_CALLBACK_PREFIX}${scope}:${params.scope === scope ? params.page : 1}`,
  }));

  const prevPage = Math.max(1, params.page - 1);
  const nextPage = Math.min(params.totalPages, params.page + 1);
  const pagerRow: TelegramInlineKeyboardButton[] = [
    {
      text: params.locale === "zh-CN" ? "上一页" : "Prev",
      callbackData: `${SESSIONS_CALLBACK_PREFIX}${params.scope}:${prevPage}`,
    },
    {
      text: params.locale === "zh-CN"
        ? `第${params.page}/${params.totalPages}页`
        : `Page ${params.page}/${params.totalPages}`,
      callbackData: `${SESSIONS_CALLBACK_PREFIX}${params.scope}:${params.page}`,
    },
    {
      text: params.locale === "zh-CN" ? "下一页" : "Next",
      callbackData: `${SESSIONS_CALLBACK_PREFIX}${params.scope}:${nextPage}`,
    },
  ];

  return [tabRow, pagerRow];
}

function collectVisibleSessionIds(params: {
  db: HiBossDatabase;
  agentName: string;
  chatId: string;
  adapterType: string;
  ownerUserId?: string;
}): Set<string> {
  const out = new Set<string>();
  for (const scope of SESSION_SCOPE_VALUES) {
    const items = params.db.listSessionsForScope({
      agentName: params.agentName,
      scope,
      adapterType: params.adapterType,
      chatId: params.chatId,
      ownerUserId: params.ownerUserId,
      limit: SESSIONS_MAX_TOTAL,
      offset: 0,
    });
    for (const item of items) {
      out.add(item.session.id);
    }
  }
  return out;
}

function resolveSessionInput(params: {
  db: HiBossDatabase;
  agentName: string;
  rawId: string;
}):
  | { ok: true; session: AgentSessionRecord }
  | { ok: false; message: string } {
  const trimmed = params.rawId.trim();
  if (!trimmed) {
    return { ok: false, message: "invalid-id" };
  }

  const direct = params.db.getAgentSessionById(trimmed);
  if (direct && direct.agentName === params.agentName) {
    return { ok: true, session: direct };
  }

  const prefix = normalizeIdPrefixInput(trimmed);
  if (prefix.length < DEFAULT_ID_PREFIX_LEN || !isHexLower(prefix)) {
    return { ok: false, message: "invalid-id" };
  }

  const matches = params.db.findAgentSessionsByIdPrefix(params.agentName, prefix, 20);
  if (matches.length === 1) {
    return { ok: true, session: matches[0]! };
  }
  if (matches.length === 0) {
    return { ok: false, message: "not-found" };
  }

  const candidates = matches.slice(0, 10).map((item) => formatShortId(item.id)).join(", ");
  return { ok: false, message: `ambiguous-id: ${candidates}` };
}

function buildAgentStatusText(params: { db: HiBossDatabase; executor: AgentExecutor; agentName: string }): string {
  const ui = getUiText(resolveUiLocale(params.db.getConfig("ui_locale")));
  const agent = params.db.getAgentByNameCaseInsensitive(params.agentName);
  if (!agent) {
    return ui.channel.agentNotFound;
  }

  const bossTz = params.db.getBossTimezone();
  const effectiveProvider = agent.provider ?? DEFAULT_AGENT_PROVIDER;
  const effectivePermissionLevel = agent.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL;
  const effectiveWorkspace = agent.workspace ?? getDefaultRuntimeWorkspace();

  const isBusy = params.executor.isAgentBusy(agent.name);
  const pendingCount = params.db.countDuePendingEnvelopesForAgent(agent.name);
  const bindings = params.db.getBindingsByAgentName(agent.name).map((b) => b.adapterType);

  const currentRun = isBusy ? params.db.getCurrentRunningAgentRun(agent.name) : null;
  const lastRun = params.db.getLastFinishedAgentRun(agent.name);

  const lines: string[] = [];
  lines.push(`name: ${agent.name}`);
  lines.push(`workspace: ${effectiveWorkspace}`);
  lines.push(`provider: ${effectiveProvider}`);
  lines.push(`model: ${agent.model ?? "default"}`);
  lines.push(`reasoning-effort: ${agent.reasoningEffort ?? "default"}`);
  lines.push(`permission-level: ${effectivePermissionLevel}`);
  if (bindings.length > 0) {
    lines.push(`bindings: ${bindings.join(", ")}`);
  }

  if (agent.sessionPolicy) {
    const sp = agent.sessionPolicy;
    if (typeof sp.dailyResetAt === "string" && sp.dailyResetAt) {
      lines.push(`session-daily-reset-at: ${sp.dailyResetAt}`);
    }
    if (typeof sp.idleTimeout === "string" && sp.idleTimeout) {
      lines.push(`session-idle-timeout: ${sp.idleTimeout}`);
    }
    if (typeof sp.maxContextLength === "number") {
      lines.push(`session-max-context-length: ${sp.maxContextLength}`);
    }
  }

  const agentState = isBusy ? "running" : "idle";
  const agentHealth = !lastRun ? "unknown" : lastRun.status === "failed" ? "error" : "ok";

  lines.push(`agent-state: ${agentState}`);
  lines.push(`agent-health: ${agentHealth}`);
  lines.push(`pending-count: ${pendingCount}`);

  if (currentRun) {
    lines.push(`current-run-id: ${formatShortId(currentRun.id)}`);
    lines.push(`current-run-started-at: ${formatUnixMsAsTimeZoneOffset(currentRun.startedAt, bossTz)}`);
  }

  if (!lastRun) {
    lines.push("last-run-status: none");
    return lines.join("\n");
  }

  lines.push(`last-run-id: ${formatShortId(lastRun.id)}`);
  lines.push(
    `last-run-status: ${
      lastRun.status === "failed"
        ? "failed"
        : lastRun.status === "cancelled"
          ? "cancelled"
          : "completed"
    }`
  );
  lines.push(`last-run-started-at: ${formatUnixMsAsTimeZoneOffset(lastRun.startedAt, bossTz)}`);
  if (typeof lastRun.completedAt === "number") {
    lines.push(`last-run-completed-at: ${formatUnixMsAsTimeZoneOffset(lastRun.completedAt, bossTz)}`);
  }
  if (typeof lastRun.contextLength === "number") {
    lines.push(`last-run-context-length: ${lastRun.contextLength}`);
  }
  if ((lastRun.status === "failed" || lastRun.status === "cancelled") && lastRun.error) {
    lines.push(`last-run-error: ${lastRun.error}`);
  }

  return lines.join("\n");
}

async function handleSessionsCommand(params: {
  db: HiBossDatabase;
  command: EnrichedChannelCommand;
  locale: "en" | "zh-CN";
}): Promise<ChannelCommandResponse> {
  const c = params.command;
  const agentName = c.agentName!;
  const view = parseSessionsView(c.args);

  const totalRaw = params.db.countSessionsForScope({
    agentName,
    scope: view.scope,
    adapterType: "telegram",
    chatId: c.chatId,
    ownerUserId: c.authorId,
  });

  const total = Math.min(SESSIONS_MAX_TOTAL, totalRaw);
  const totalPages = Math.max(1, Math.ceil(Math.max(1, total) / SESSIONS_PAGE_SIZE));
  const page = Math.max(1, Math.min(view.page, totalPages));
  const offset = (page - 1) * SESSIONS_PAGE_SIZE;

  const items = params.db.listSessionsForScope({
    agentName,
    scope: view.scope,
    adapterType: "telegram",
    chatId: c.chatId,
    ownerUserId: c.authorId,
    limit: SESSIONS_PAGE_SIZE,
    offset,
  });

  const active = params.db.getChannelSessionBinding(agentName, "telegram", c.chatId);
  const tz = params.db.getBossTimezone();

  const lines: string[] = [];
  lines.push("sessions: ok");
  lines.push(`scope: ${view.scope}`);
  lines.push(`page: ${page}`);
  lines.push(`page-size: ${SESSIONS_PAGE_SIZE}`);
  lines.push(`total: ${total}`);
  lines.push(`total-pages: ${totalPages}`);
  lines.push(`active-session-id: ${active ? formatShortId(active.activeSessionId) : "(none)"}`);
  lines.push(`session-count: ${items.length}`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const n = i + 1;
    lines.push(`session-${n}-id: ${formatShortId(item.session.id)}`);
    lines.push(`session-${n}-last-active-at: ${formatUnixMsAsTimeZoneOffset(item.session.lastActiveAt, tz)}`);
    lines.push(`session-${n}-source: channel:${item.link.adapterType}:${item.link.chatId}`);
    lines.push(`session-${n}-is-active: ${active?.activeSessionId === item.session.id ? "true" : "false"}`);
  }

  return {
    text: lines.join("\n"),
    telegram: {
      inlineKeyboard: buildSessionsKeyboard({
        scope: view.scope,
        page,
        totalPages,
        locale: params.locale,
      }),
      ...(c.isCallback && c.messageId ? { editMessageId: c.messageId } : {}),
    },
  };
}

async function handleSessionSwitchCommand(params: {
  db: HiBossDatabase;
  executor: AgentExecutor;
  command: EnrichedChannelCommand;
  ui: ReturnType<typeof getUiText>;
}): Promise<ChannelCommandResponse> {
  const c = params.command;
  const raw = c.args?.trim() ?? "";
  if (!raw) {
    return { text: params.ui.channel.sessionUsage };
  }

  const resolved = resolveSessionInput({
    db: params.db,
    agentName: c.agentName!,
    rawId: raw,
  });

  if (!resolved.ok) {
    if (resolved.message === "invalid-id") {
      return { text: params.ui.channel.sessionSwitchInvalidId };
    }
    if (resolved.message === "not-found") {
      return { text: params.ui.channel.sessionSwitchInvalidId };
    }
    return { text: resolved.message };
  }

  const visible = collectVisibleSessionIds({
    db: params.db,
    agentName: c.agentName!,
    adapterType: "telegram",
    chatId: c.chatId,
    ownerUserId: c.authorId,
  });

  if (!visible.has(resolved.session.id)) {
    return { text: params.ui.channel.sessionSwitchNotVisible };
  }

  const switched = params.db.switchChannelActiveSession({
    agentName: c.agentName!,
    adapterType: "telegram",
    chatId: c.chatId,
    targetSessionId: resolved.session.id,
    ownerUserId: c.authorId,
  });
  params.executor.invalidateChannelSessionCache(c.agentName!, "telegram", c.chatId);

  return {
    text: [
      "session-switch: ok",
      `old-session-id: ${switched.oldSessionId ? formatShortId(switched.oldSessionId) : "(none)"}`,
      `new-session-id: ${formatShortId(switched.newSessionId)}`,
    ].join("\n"),
  };
}

export function createChannelCommandHandler(params: {
  db: HiBossDatabase;
  executor: AgentExecutor;
  router: MessageRouter;
}): ChannelCommandHandler {
  return (command): ChannelCommandResponse | void | Promise<ChannelCommandResponse | void> => {
    const locale = resolveUiLocale(params.db.getConfig("ui_locale"));
    const ui = getUiText(locale);
    const c = command as EnrichedChannelCommand;
    if (typeof c.command !== "string") return;

    if (c.command === "new" && typeof c.agentName === "string" && c.agentName) {
      const agent = params.db.getAgentByNameCaseInsensitive(c.agentName);
      if (!agent) return { text: ui.channel.agentNotFound };

      const switched = params.db.createFreshChannelSessionAndSwitch({
        agentName: c.agentName,
        adapterType: "telegram",
        chatId: c.chatId,
        ownerUserId: c.authorId,
        provider: agent.provider ?? DEFAULT_AGENT_PROVIDER,
      });
      params.executor.invalidateChannelSessionCache(c.agentName, "telegram", c.chatId);

      return {
        text: [
          "session-new: ok",
          `old-session-id: ${switched.oldSessionId ? formatShortId(switched.oldSessionId) : "(none)"}`,
          `new-session-id: ${formatShortId(switched.newSession.id)}`,
        ].join("\n"),
      };
    }

    if (c.command === "sessions" && typeof c.agentName === "string" && c.agentName) {
      return handleSessionsCommand({
        db: params.db,
        command: c,
        locale,
      });
    }

    if (c.command === "session" && typeof c.agentName === "string" && c.agentName) {
      return handleSessionSwitchCommand({
        db: params.db,
        executor: params.executor,
        command: c,
        ui,
      });
    }

    if (c.command === "status" && typeof c.agentName === "string" && c.agentName) {
      return { text: buildAgentStatusText({ db: params.db, executor: params.executor, agentName: c.agentName }) };
    }

    if (c.command === "abort" && typeof c.agentName === "string" && c.agentName) {
      const cancelledRun = params.executor.abortCurrentRun(c.agentName, "telegram:/abort");
      const clearedPendingCount = params.db.markDuePendingNonCronEnvelopesDoneForAgent(c.agentName);
      const lines = [
        ui.channel.abortOk,
        `agent-name: ${c.agentName}`,
        `cancelled-run: ${cancelledRun ? "true" : "false"}`,
        `cleared-pending-count: ${clearedPendingCount}`,
      ];
      return { text: lines.join("\n") };
    }

    // One-shot commands: /isolated and /clone
    if (
      (c.command === "isolated" || c.command === "clone") &&
      typeof c.agentName === "string" && c.agentName
    ) {
      return handleOneshotCommand(params, c, c.command as OneshotType);
    }
  };
}

async function handleOneshotCommand(
  params: { db: HiBossDatabase; router: MessageRouter },
  command: EnrichedChannelCommand,
  mode: OneshotType,
): Promise<ChannelCommandResponse | void> {
  const ui = getUiText(resolveUiLocale(params.db.getConfig("ui_locale")));
  const agentName = command.agentName!;
  const text = command.args?.trim();

  if (!text) {
    return { text: ui.channel.usage(mode) };
  }

  const fromAddress = formatChannelAddress("telegram", command.chatId);
  const toAddress = formatAgentAddress(agentName);

  try {
    await params.router.routeEnvelope({
      from: fromAddress,
      to: toAddress,
      fromBoss: true,
      content: { text },
      metadata: {
        oneshotType: mode,
        platform: "telegram",
        channelMessageId: command.messageId,
        author:
          command.authorId || command.authorUsername
            ? {
                ...(command.authorId ? { id: command.authorId } : {}),
                ...(command.authorUsername ? { username: command.authorUsername } : {}),
              }
            : undefined,
        chat: { id: command.chatId },
      },
    });
  } catch (err) {
    logEvent("error", "oneshot-envelope-create-failed", {
      "agent-name": agentName,
      mode,
      error: errorMessage(err),
    });
    return { text: ui.channel.failedToCreateEnvelope(mode) };
  }

  return {
    text: [
      ui.channel.turnInitiated(mode),
      `oneshot-mode: ${mode}`,
      "active-session-changed: false",
    ].join("\n"),
  };
}
