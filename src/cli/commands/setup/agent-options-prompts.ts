import { input, select } from "@inquirer/prompts";
import { parseDailyResetAt, parseDurationToMs } from "../../../shared/session-policy.js";
import {
  DEFAULT_SETUP_PERMISSION_LEVEL,
  SETUP_MODEL_CHOICES_BY_PROVIDER,
} from "../../../shared/defaults.js";
import type { SetupConfig } from "./types.js";

type Provider = "claude" | "codex";
type PermissionLevel = NonNullable<SetupConfig["speakerAgent"]["permissionLevel"]>;

const MODEL_PROVIDER_DEFAULT = "default";
const MODEL_CUSTOM = "__custom__";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function promptAgentProvider(message: string): Promise<Provider> {
  return select<Provider>({
    message,
    choices: [
      { value: "claude", name: "claude" },
      { value: "codex", name: "codex" },
    ],
  });
}

export async function promptAgentModel(params: {
  provider: Provider;
  message: string;
}): Promise<string | null> {
  const modelChoice = await select<string>({
    message: params.message,
    choices: [
      { value: MODEL_PROVIDER_DEFAULT, name: "null (use provider default; do not override)" },
      ...(params.provider === "claude"
        ? SETUP_MODEL_CHOICES_BY_PROVIDER.claude.map((value) => ({ value, name: value }))
        : SETUP_MODEL_CHOICES_BY_PROVIDER.codex.map((value) => ({ value, name: value }))),
      { value: MODEL_CUSTOM, name: "Custom model id..." },
    ],
    default: MODEL_PROVIDER_DEFAULT,
  });

  if (modelChoice === MODEL_PROVIDER_DEFAULT) {
    return null;
  }

  if (modelChoice === MODEL_CUSTOM) {
    const customModel = (
      await input({
        message: "Custom model id:",
        validate: (value) => {
          const trimmed = value.trim();
          if (!trimmed) return "Model id cannot be empty";
          if (trimmed === "provider_default") return "Use 'default' to clear; or enter a real model id";
          return true;
        },
      })
    ).trim();
    return customModel === "default" ? null : customModel;
  }

  return modelChoice;
}

export async function promptAgentReasoningEffort(
  message: string
): Promise<SetupConfig["speakerAgent"]["reasoningEffort"]> {
  const reasoningEffortChoice = await select<"default" | "none" | "low" | "medium" | "high" | "xhigh">({
    message,
    choices: [
      { value: "default", name: "default (use provider default; do not override)" },
      { value: "none", name: "None - No reasoning (fastest)" },
      { value: "low", name: "Low - Quick responses" },
      { value: "medium", name: "Medium - Balanced (recommended)" },
      { value: "high", name: "High - Thorough analysis" },
      { value: "xhigh", name: "XHigh - Extra thorough (slowest)" },
    ],
    default: "default",
  });

  return reasoningEffortChoice === "default" ? null : reasoningEffortChoice;
}

export async function promptAgentPermissionLevel(params: {
  message: string;
  defaultValue?: PermissionLevel;
}): Promise<PermissionLevel> {
  return select<PermissionLevel>({
    message: params.message,
    choices: [
      { value: "restricted", name: "Restricted" },
      { value: "standard", name: "Standard (recommended)" },
      { value: "privileged", name: "Privileged" },
      { value: "boss", name: "Boss" },
    ],
    default: params.defaultValue ?? DEFAULT_SETUP_PERMISSION_LEVEL,
  });
}

export async function promptAgentAdvancedOptions(params: {
  agentLabel: string;
}): Promise<{
  sessionPolicy?: SetupConfig["speakerAgent"]["sessionPolicy"];
  metadata?: Record<string, unknown>;
}> {
  const sessionDailyResetAt = (
    await input({
      message: `${params.agentLabel} session daily reset at (HH:MM) (optional):`,
      default: "",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return true;
        try {
          parseDailyResetAt(trimmed);
          return true;
        } catch (err) {
          return (err as Error).message;
        }
      },
    })
  ).trim();

  const sessionIdleTimeout = (
    await input({
      message: `${params.agentLabel} session idle timeout (e.g., 2h, 30m) (optional):`,
      default: "",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return true;
        try {
          parseDurationToMs(trimmed);
          return true;
        } catch (err) {
          return (err as Error).message;
        }
      },
    })
  ).trim();

  const sessionMaxContextLengthRaw = (
    await input({
      message: `${params.agentLabel} session max context length (optional):`,
      default: "",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return true;
        const num = Number(trimmed);
        if (!Number.isFinite(num) || num <= 0) return "Session max context length must be a positive number";
        return true;
      },
    })
  ).trim();

  const sessionMaxContextLength = sessionMaxContextLengthRaw ? Math.trunc(Number(sessionMaxContextLengthRaw)) : undefined;

  const metadataRaw = (
    await input({
      message: `${params.agentLabel} metadata JSON (optional):`,
      default: "",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return true;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!isPlainObject(parsed)) return "Metadata must be a JSON object";
          return true;
        } catch {
          return "Invalid JSON";
        }
      },
    })
  ).trim();

  const metadata = metadataRaw ? (JSON.parse(metadataRaw) as Record<string, unknown>) : undefined;

  const sessionPolicy =
    sessionDailyResetAt || sessionIdleTimeout || sessionMaxContextLength !== undefined
      ? {
          dailyResetAt: sessionDailyResetAt ? parseDailyResetAt(sessionDailyResetAt).normalized : undefined,
          idleTimeout: sessionIdleTimeout || undefined,
          maxContextLength: sessionMaxContextLength,
        }
      : undefined;

  return {
    sessionPolicy,
    metadata,
  };
}
