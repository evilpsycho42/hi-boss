import type { OneshotType } from "../envelope/types.js";
import type { UiLocale } from "./ui-locale.js";

interface TelegramCommandDescription {
  command: "login" | "new" | "status" | "trace" | "provider" | "abort" | "isolated" | "clone" | "sessions" | "session";
  description: string;
}

interface UiTextBundle {
  bridge: {
    unboundAdapter(platform: string): string;
  };
  channel: {
    accessDenied: string;
    loginRequired: string;
    loginUsage: string;
    loginOk(params: {
      tokenPrefix: string;
      fromBoss: boolean;
      userName: string;
      role: "admin" | "user";
    }): string;
    agentNotFound: string;
    sessionRefreshRequested: string;
    sessionSwitchInvalidId: string;
    sessionSwitchNotFound: string;
    sessionSwitchNotVisible: string;
    providerUsage: string;
    providerSwitchFailed: string;
    traceUsage: string;
    abortOk: string;
    usage(mode: OneshotType): string;
    sessionUsage: string;
    failedToCreateEnvelope(mode: OneshotType): string;
    turnInitiated(mode: OneshotType): string;
  };
  telegram: {
    commandDescriptions: TelegramCommandDescription[];
  };
}

const EN_TEXT: UiTextBundle = {
  bridge: {
    unboundAdapter: (platform) =>
      [
        `not-configured: no agent is bound to this ${platform} bot`,
        `fix: hiboss agent set --token <admin-token> --name <agent-name> --bind-adapter-type ${platform} --bind-adapter-token <adapter-token>`,
      ].join("\n"),
  },
  channel: {
    accessDenied: "error: Access denied",
    loginRequired: "error: Login required. Use /login <token>",
    loginUsage: "Usage: /login <token>",
    loginOk: ({ tokenPrefix, fromBoss, userName, role }) =>
      [
        "login: ok",
        `user-name: ${userName}`,
        `role: ${role}`,
        `token-prefix: ${tokenPrefix}`,
        `from-boss: ${fromBoss ? "true" : "false"}`,
      ].join("\n"),
    agentNotFound: "error: Agent not found",
    sessionRefreshRequested: "Session refresh requested.",
    sessionSwitchInvalidId: "error: Invalid session id",
    sessionSwitchNotFound: "error: Session not found",
    sessionSwitchNotVisible: "error: Session is not visible in this scope",
    providerUsage:
      "Usage: /provider <claude|codex> [model=<name|default>] [reasoning-effort=<none|low|medium|high|xhigh|default>]",
    providerSwitchFailed: "error: Failed to switch provider",
    traceUsage: "Usage: /trace",
    abortOk: "abort: ok",
    usage: (mode) => `Usage: /${mode} <message>`,
    sessionUsage: "Usage: /session <session-id>",
    failedToCreateEnvelope: (mode) => `Failed to create ${mode} envelope.`,
    turnInitiated: (mode) => {
      const label = mode === "clone" ? "Clone" : "Isolated";
      return `${label} turn initiated.`;
    },
  },
  telegram: {
    commandDescriptions: [
      { command: "login", description: "Bind chat token for this bot" },
      { command: "new", description: "Start a new session" },
      { command: "status", description: "Show agent status" },
      { command: "trace", description: "Show current run trace" },
      { command: "provider", description: "Switch provider and optional model/reasoning" },
      { command: "abort", description: "Abort current run and clear message queue" },
      { command: "isolated", description: "One-shot with clean context" },
      { command: "clone", description: "One-shot with current session context" },
      { command: "sessions", description: "Browse recent sessions" },
      { command: "session", description: "Switch current chat to a session" },
    ],
  },
};

const ZH_CN_TEXT: UiTextBundle = {
  bridge: {
    unboundAdapter: (platform) =>
      [
        `not-configured: 当前 ${platform} bot 未绑定任何 agent`,
        `fix: hiboss agent set --token <admin-token> --name <agent-name> --bind-adapter-type ${platform} --bind-adapter-token <adapter-token>`,
      ].join("\n"),
  },
  channel: {
    accessDenied: "error: 没有权限",
    loginRequired: "error: 需要先登录，请先执行 /login <token>",
    loginUsage: "用法: /login <token>",
    loginOk: ({ tokenPrefix, fromBoss, userName, role }) =>
      [
        "login: ok",
        `user-name: ${userName}`,
        `role: ${role}`,
        `token-prefix: ${tokenPrefix}`,
        `from-boss: ${fromBoss ? "true" : "false"}`,
      ].join("\n"),
    agentNotFound: "error: 未找到对应 Agent",
    sessionRefreshRequested: "已请求刷新会话。",
    sessionSwitchInvalidId: "error: 会话 ID 无效",
    sessionSwitchNotFound: "error: 未找到该会话",
    sessionSwitchNotVisible: "error: 该会话当前不可见",
    providerUsage:
      "用法: /provider <claude|codex> [model=<name|default>] [reasoning-effort=<none|low|medium|high|xhigh|default>]",
    providerSwitchFailed: "error: 切换 provider 失败",
    traceUsage: "用法: /trace",
    abortOk: "abort: ok",
    usage: (mode) => `用法: /${mode} <消息>`,
    sessionUsage: "用法: /session <会话-id>",
    failedToCreateEnvelope: (mode) => `创建 ${mode} envelope 失败。`,
    turnInitiated: (mode) => {
      const label = mode === "clone" ? "克隆模式" : "隔离模式";
      return `${label} 已启动。`;
    },
  },
  telegram: {
    commandDescriptions: [
      { command: "login", description: "绑定当前聊天 token" },
      { command: "new", description: "开启新会话" },
      { command: "status", description: "查看 Agent 状态" },
      { command: "trace", description: "查看当前 run trace" },
      { command: "provider", description: "切换 provider，并可设置 model/reasoning" },
      { command: "abort", description: "中止当前运行并清空消息队列" },
      { command: "isolated", description: "隔离单次执行（全新上下文）" },
      { command: "clone", description: "克隆单次执行（沿用当前上下文）" },
      { command: "sessions", description: "浏览最近会话" },
      { command: "session", description: "切换当前聊天会话" },
    ],
  },
};

export function getUiText(locale: UiLocale): UiTextBundle {
  if (locale === "zh-CN") {
    return ZH_CN_TEXT;
  }
  return EN_TEXT;
}
