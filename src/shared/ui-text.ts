import type { OneshotType } from "../envelope/types.js";
import type { UiLocale } from "./ui-locale.js";

interface TelegramCommandDescription {
  command: "new" | "status" | "abort" | "isolated" | "clone";
  description: string;
}

interface UiTextBundle {
  bridge: {
    unboundAdapter(platform: string): string;
  };
  channel: {
    agentNotFound: string;
    sessionRefreshRequested: string;
    abortOk: string;
    usage(mode: OneshotType): string;
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
        `fix: hiboss agent set --token <boss-token> --name <agent-name> --bind-adapter-type ${platform} --bind-adapter-token <adapter-token>`,
      ].join("\n"),
  },
  channel: {
    agentNotFound: "error: Agent not found",
    sessionRefreshRequested: "Session refresh requested.",
    abortOk: "abort: ok",
    usage: (mode) => `Usage: /${mode} <message>`,
    failedToCreateEnvelope: (mode) => `Failed to create ${mode} envelope.`,
    turnInitiated: (mode) => {
      const label = mode === "clone" ? "Clone" : "Isolated";
      return `${label} turn initiated.`;
    },
  },
  telegram: {
    commandDescriptions: [
      { command: "new", description: "Start a new session" },
      { command: "status", description: "Show agent status" },
      { command: "abort", description: "Abort current run and clear message queue" },
      { command: "isolated", description: "One-shot with clean context" },
      { command: "clone", description: "One-shot with current session context" },
    ],
  },
};

const ZH_CN_TEXT: UiTextBundle = {
  bridge: {
    unboundAdapter: (platform) =>
      [
        `not-configured: 当前 ${platform} bot 未绑定任何 agent`,
        `fix: hiboss agent set --token <boss-token> --name <agent-name> --bind-adapter-type ${platform} --bind-adapter-token <adapter-token>`,
      ].join("\n"),
  },
  channel: {
    agentNotFound: "error: 未找到对应 Agent",
    sessionRefreshRequested: "已请求刷新会话。",
    abortOk: "abort: ok",
    usage: (mode) => `用法: /${mode} <消息>`,
    failedToCreateEnvelope: (mode) => `创建 ${mode} envelope 失败。`,
    turnInitiated: (mode) => {
      const label = mode === "clone" ? "克隆模式" : "隔离模式";
      return `${label} 已启动。`;
    },
  },
  telegram: {
    commandDescriptions: [
      { command: "new", description: "开启新会话" },
      { command: "status", description: "查看 Agent 状态" },
      { command: "abort", description: "中止当前运行并清空消息队列" },
      { command: "isolated", description: "隔离单次执行（全新上下文）" },
      { command: "clone", description: "克隆单次执行（沿用当前上下文）" },
    ],
  },
};

export function getUiText(locale: UiLocale): UiTextBundle {
  if (locale === "zh-CN") {
    return ZH_CN_TEXT;
  }
  return EN_TEXT;
}
