import type { ChannelCommandResponse } from "../adapters/types.js";
import type { AgentExecutor } from "../agent/executor.js";
import { DEFAULT_AGENT_PROVIDER } from "../shared/defaults.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import type { getUiText } from "../shared/ui-text.js";
import type { HiBossDatabase } from "./db/database.js";
import { mutateSettingsAndSync } from "./settings-sync.js";

type Provider = "claude" | "codex";
type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

interface ProviderSwitchArgs {
  provider: Provider;
  model: string | null | undefined;
  reasoningEffort: ReasoningEffort | null | undefined;
}

function parseReasoningEffortToken(raw: string): ReasoningEffort | null | undefined {
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "default") return null;
  if (value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return undefined;
}

function parseModelToken(raw: string): string | null | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.toLowerCase() === "default") return null;
  return value;
}

function assignProviderOption(
  target: ProviderSwitchArgs,
  keyRaw: string,
  valueRaw: string
): boolean {
  const key = keyRaw.trim().toLowerCase();
  if (!key) return false;

  if (key === "model" || key === "m") {
    const model = parseModelToken(valueRaw);
    if (model === undefined) return false;
    target.model = model;
    return true;
  }

  if (key === "reasoning" || key === "reasoning-effort" || key === "effort" || key === "r") {
    const reasoningEffort = parseReasoningEffortToken(valueRaw);
    if (reasoningEffort === undefined) return false;
    target.reasoningEffort = reasoningEffort;
    return true;
  }

  return false;
}

function parseProviderArgs(rawArgs: string | undefined): ProviderSwitchArgs | null {
  const tokens = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
  const providerToken = tokens[0]?.toLowerCase();
  if (providerToken !== "claude" && providerToken !== "codex") {
    return null;
  }

  const parsed: ProviderSwitchArgs = {
    provider: providerToken,
    model: undefined,
    reasoningEffort: undefined,
  };

  const positionals: string[] = [];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();

    if (lower === "--model" || lower === "-m") {
      const value = tokens[index + 1];
      if (!value) return null;
      const model = parseModelToken(value);
      if (model === undefined) return null;
      parsed.model = model;
      index++;
      continue;
    }
    if (lower === "--reasoning-effort" || lower === "--reasoning" || lower === "--effort" || lower === "-r") {
      const value = tokens[index + 1];
      if (!value) return null;
      const reasoningEffort = parseReasoningEffortToken(value);
      if (reasoningEffort === undefined) return null;
      parsed.reasoningEffort = reasoningEffort;
      index++;
      continue;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 0) {
      const key = token.slice(0, equalsIndex);
      const value = token.slice(equalsIndex + 1);
      if (!assignProviderOption(parsed, key, value)) return null;
      continue;
    }

    positionals.push(token);
  }

  for (let index = 0; index < positionals.length; index++) {
    const token = positionals[index]!;
    if (
      parsed.model === undefined &&
      parsed.reasoningEffort === undefined &&
      positionals.length === 1
    ) {
      const maybeReasoning = parseReasoningEffortToken(token);
      if (maybeReasoning !== undefined) {
        parsed.reasoningEffort = maybeReasoning;
        continue;
      }
    }

    if (parsed.model === undefined) {
      const model = parseModelToken(token);
      if (model === undefined) return null;
      parsed.model = model;
      continue;
    }

    if (parsed.reasoningEffort === undefined) {
      const reasoningEffort = parseReasoningEffortToken(token);
      if (reasoningEffort === undefined) return null;
      parsed.reasoningEffort = reasoningEffort;
      continue;
    }

    return null;
  }

  return parsed;
}

function formatValueOrDefault(value: string | null | undefined): string {
  return value ?? "default";
}

export async function handleProviderSwitchCommand(params: {
  db: HiBossDatabase;
  executor: AgentExecutor;
  hibossDir?: string;
  agentName: string;
  adapterType?: string;
  args?: string;
  ui: ReturnType<typeof getUiText>;
}): Promise<ChannelCommandResponse> {
  const parsed = parseProviderArgs(params.args);
  if (!parsed) {
    return { text: params.ui.channel.providerUsage };
  }

  const agent = params.db.getAgentByNameCaseInsensitive(params.agentName);
  if (!agent) {
    return { text: params.ui.channel.agentNotFound };
  }

  const nextProvider = parsed.provider;
  const oldProvider = agent.provider ?? DEFAULT_AGENT_PROVIDER;
  const oldModel = agent.model ?? null;
  const oldReasoningEffort = agent.reasoningEffort ?? null;

  let nextModel = oldProvider === nextProvider ? oldModel : null;
  let nextReasoningEffort = oldProvider === nextProvider ? oldReasoningEffort : null;
  if (parsed.model !== undefined) {
    nextModel = parsed.model;
  }
  if (parsed.reasoningEffort !== undefined) {
    nextReasoningEffort = parsed.reasoningEffort;
  }

  const hasChanges =
    oldProvider !== nextProvider ||
    oldModel !== nextModel ||
    oldReasoningEffort !== nextReasoningEffort;

  if (!hasChanges) {
    return {
      text: [
        "provider-switch: noop",
        `agent-name: ${agent.name}`,
        `provider: ${oldProvider}`,
        `model: ${formatValueOrDefault(oldModel)}`,
        `reasoning-effort: ${formatValueOrDefault(oldReasoningEffort)}`,
        "session-refresh-requested: false",
      ].join("\n"),
    };
  }

  try {
    if (params.hibossDir) {
      await mutateSettingsAndSync({
        hibossDir: params.hibossDir,
        db: params.db,
        mutate: (settings) => {
          const target = settings.agents.find((item) => item.name.toLowerCase() === agent.name.toLowerCase());
          if (!target) {
            throw new Error(`Agent '${agent.name}' not found in settings`);
          }
          target.provider = nextProvider;
          target.model = nextModel;
          target.reasoningEffort = nextReasoningEffort;
        },
      });
    } else {
      // Test/dev fallback when settings file context is not available.
      params.db.updateAgentFields(agent.name, {
        provider: nextProvider,
        model: nextModel,
        reasoningEffort: nextReasoningEffort,
      });
    }
  } catch (err) {
    logEvent("error", "channel-provider-switch-failed", {
      "agent-name": agent.name,
      "old-provider": oldProvider,
      "new-provider": nextProvider,
      error: errorMessage(err),
    });
    return { text: params.ui.channel.providerSwitchFailed };
  }

  params.executor.requestSessionRefresh(
    agent.name,
    `${params.adapterType ?? "telegram"}:/provider`
  );

  return {
    text: [
      "provider-switch: ok",
      `agent-name: ${agent.name}`,
      `old-provider: ${oldProvider}`,
      `new-provider: ${nextProvider}`,
      `old-model: ${formatValueOrDefault(oldModel)}`,
      `new-model: ${formatValueOrDefault(nextModel)}`,
      `old-reasoning-effort: ${formatValueOrDefault(oldReasoningEffort)}`,
      `new-reasoning-effort: ${formatValueOrDefault(nextReasoningEffort)}`,
      "session-refresh-requested: true",
    ].join("\n"),
  };
}
