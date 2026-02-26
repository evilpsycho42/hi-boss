import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentExecutor } from "../agent/executor.js";
import { getProviderCliEnvOverrides } from "../agent/provider-env.js";
import {
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  getDefaultRuntimeWorkspace,
} from "../shared/defaults.js";
import { formatShortId } from "../shared/id-format.js";
import { formatUnixMsAsTimeZoneOffset } from "../shared/time.js";
import { resolveUiLocale } from "../shared/ui-locale.js";
import { getUiText } from "../shared/ui-text.js";
import type { HiBossDatabase } from "./db/database.js";

interface CodexModelProviderDetails {
  name: string | null;
  wireApi: string | null;
  requiresOpenaiAuth: boolean | null;
  baseUrl: string | null;
}

interface ParsedCodexConfig {
  path: string;
  exists: boolean;
  modelProvider: string | null;
  model: string | null;
  modelReasoningEffort: string | null;
  disableResponseStorage: boolean | null;
  featuresMultiAgent: boolean | null;
  modelProviderDetails: CodexModelProviderDetails | null;
}

function stripTomlInlineComment(raw: string): string {
  let inQuotes = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const ch = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inQuotes && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === "#") {
      return raw.slice(0, index).trim();
    }
  }
  return raw.trim();
}

function parseTomlStringOrBool(raw: string): string | boolean | null {
  const value = stripTomlInlineComment(raw);
  if (!value) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("\"") && value.endsWith("\"")) {
    const inner = value.slice(1, -1);
    return inner.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return value;
}

function readCodexConfig(codexHome: string): ParsedCodexConfig {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) {
    return {
      path: configPath,
      exists: false,
      modelProvider: null,
      model: null,
      modelReasoningEffort: null,
      disableResponseStorage: null,
      featuresMultiAgent: null,
      modelProviderDetails: null,
    };
  }

  const text = fs.readFileSync(configPath, "utf8");
  const lines = text.split(/\r?\n/);
  let section: string | null = null;

  let modelProvider: string | null = null;
  let model: string | null = null;
  let modelReasoningEffort: string | null = null;
  let disableResponseStorage: boolean | null = null;
  let featuresMultiAgent: boolean | null = null;

  const providers = new Map<string, CodexModelProviderDetails>();
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1]!.trim();
    const parsedValue = parseTomlStringOrBool(kvMatch[2]!);
    if (parsedValue === null) continue;

    if (!section) {
      if (key === "model_provider" && typeof parsedValue === "string") {
        modelProvider = parsedValue;
        continue;
      }
      if (key === "model" && typeof parsedValue === "string") {
        model = parsedValue;
        continue;
      }
      if (key === "model_reasoning_effort" && typeof parsedValue === "string") {
        modelReasoningEffort = parsedValue;
        continue;
      }
      if (key === "disable_response_storage" && typeof parsedValue === "boolean") {
        disableResponseStorage = parsedValue;
      }
      continue;
    }

    if (section === "features" && key === "multi_agent" && typeof parsedValue === "boolean") {
      featuresMultiAgent = parsedValue;
      continue;
    }

    if (section.startsWith("model_providers.")) {
      const providerId = section.slice("model_providers.".length);
      if (!providerId) continue;
      const current = providers.get(providerId) ?? {
        name: null,
        wireApi: null,
        requiresOpenaiAuth: null,
        baseUrl: null,
      };
      if (key === "name" && typeof parsedValue === "string") current.name = parsedValue;
      if (key === "wire_api" && typeof parsedValue === "string") current.wireApi = parsedValue;
      if (key === "requires_openai_auth" && typeof parsedValue === "boolean") {
        current.requiresOpenaiAuth = parsedValue;
      }
      if (key === "base_url" && typeof parsedValue === "string") current.baseUrl = parsedValue;
      providers.set(providerId, current);
    }
  }

  return {
    path: configPath,
    exists: true,
    modelProvider,
    model,
    modelReasoningEffort,
    disableResponseStorage,
    featuresMultiAgent,
    modelProviderDetails: modelProvider ? (providers.get(modelProvider) ?? null) : null,
  };
}

function formatValueOrDefault(value: string | null | undefined): string {
  return value ?? "default";
}

export function buildAgentStatusText(params: { db: HiBossDatabase; executor: AgentExecutor; agentName: string }): string {
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
  const providerEnvOverrides = getProviderCliEnvOverrides(agent.metadata, effectiveProvider);
  const providerEnvOverrideKeys = Object.keys(providerEnvOverrides ?? {}).sort();

  const currentRun = isBusy ? params.db.getCurrentRunningAgentRun(agent.name) : null;
  const lastRun = params.db.getLastFinishedAgentRun(agent.name);

  let effectiveModel: string | null = agent.model ?? null;
  let effectiveReasoningEffort: string | null = agent.reasoningEffort ?? null;
  let codexConfig: ParsedCodexConfig | null = null;
  let codexHome: string | null = null;

  if (effectiveProvider === "codex") {
    codexHome = (providerEnvOverrides?.CODEX_HOME ?? "").trim() || path.join(os.homedir(), ".codex");
    try {
      codexConfig = readCodexConfig(codexHome);
      if (!effectiveModel && codexConfig.model) {
        effectiveModel = codexConfig.model;
      }
      if (!effectiveReasoningEffort && codexConfig.modelReasoningEffort) {
        effectiveReasoningEffort = codexConfig.modelReasoningEffort;
      }
    } catch {
      codexConfig = {
        path: path.join(codexHome, "config.toml"),
        exists: false,
        modelProvider: null,
        model: null,
        modelReasoningEffort: null,
        disableResponseStorage: null,
        featuresMultiAgent: null,
        modelProviderDetails: null,
      };
    }
  }

  const lines: string[] = [];
  lines.push(`name: ${agent.name}`);
  lines.push(`workspace: ${effectiveWorkspace}`);
  lines.push(`provider: ${effectiveProvider}`);
  lines.push(`model: ${formatValueOrDefault(agent.model)}`);
  lines.push(`reasoning-effort: ${formatValueOrDefault(agent.reasoningEffort)}`);
  lines.push(`effective-model: ${formatValueOrDefault(effectiveModel)}`);
  lines.push(`effective-reasoning-effort: ${formatValueOrDefault(effectiveReasoningEffort)}`);
  lines.push(`permission-level: ${effectivePermissionLevel}`);
  lines.push(
    `provider-env-override-keys: ${
      providerEnvOverrideKeys.length > 0 ? providerEnvOverrideKeys.join(", ") : "(none)"
    }`
  );
  if (bindings.length > 0) {
    lines.push(`bindings: ${bindings.join(", ")}`);
  }
  if (effectiveProvider === "codex" && codexHome && codexConfig) {
    lines.push(`codex-home: ${codexHome}`);
    lines.push(`codex-config-path: ${codexConfig.path}`);
    lines.push(`codex-config-exists: ${codexConfig.exists ? "true" : "false"}`);
    if (codexConfig.modelProvider) {
      lines.push(`codex-config-model-provider: ${codexConfig.modelProvider}`);
    }
    if (codexConfig.model) {
      lines.push(`codex-config-model: ${codexConfig.model}`);
    }
    if (codexConfig.modelReasoningEffort) {
      lines.push(`codex-config-reasoning-effort: ${codexConfig.modelReasoningEffort}`);
    }
    if (codexConfig.disableResponseStorage !== null) {
      lines.push(
        `codex-config-disable-response-storage: ${
          codexConfig.disableResponseStorage ? "true" : "false"
        }`
      );
    }
    if (codexConfig.featuresMultiAgent !== null) {
      lines.push(`codex-config-features-multi-agent: ${codexConfig.featuresMultiAgent ? "true" : "false"}`);
    }
    const providerDetails = codexConfig.modelProviderDetails;
    if (providerDetails?.name) {
      lines.push(`codex-config-provider-name: ${providerDetails.name}`);
    }
    if (providerDetails?.wireApi) {
      lines.push(`codex-config-provider-wire-api: ${providerDetails.wireApi}`);
    }
    if (providerDetails && providerDetails.requiresOpenaiAuth !== null) {
      lines.push(
        `codex-config-provider-requires-openai-auth: ${
          providerDetails.requiresOpenaiAuth ? "true" : "false"
        }`
      );
    }
    if (providerDetails?.baseUrl) {
      lines.push(`codex-config-provider-base-url: ${providerDetails.baseUrl}`);
    }
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
