import * as path from "node:path";

import {
  DEFAULT_SESSION_HANDOFF_MAX_RETRIES,
  DEFAULT_SESSION_HANDOFF_PER_SESSION_MAX_CHARS,
  DEFAULT_SESSION_HANDOFF_RECENT_DAYS,
  DEFAULT_SESSION_CONCURRENCY_GLOBAL,
  DEFAULT_SESSION_CONCURRENCY_PER_AGENT,
  DEFAULT_SETUP_PERMISSION_LEVEL,
} from "./defaults.js";
import {
  isPermissionLevel,
  type PermissionLevel,
  type PermissionPolicy,
} from "./permissions.js";
import { parseDailyResetAt, parseDurationToMs } from "./session-policy.js";
import { isValidIanaTimeZone } from "./timezone.js";
import {
  parseUserPermissionPolicyFromObject,
  type UserPermissionPolicy,
} from "./user-permissions.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "./validation.js";
import { INTERNAL_VERSION } from "./version.js";

export const SETTINGS_VERSION = INTERNAL_VERSION;
export const SETTINGS_FILENAME = "settings.json" as const;
export const SETTINGS_FILE_MODE = 0o600 as const;

export type SettingsProvider = "claude" | "codex";
export type SettingsReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
const AGENT_TOKEN_REGEX = /^[0-9a-f]{32}$/;

export interface SettingsBinding {
  adapterType: string;
  adapterToken: string;
}

export interface SettingsSessionPolicy {
  dailyResetAt?: string;
  idleTimeout?: string;
  maxContextLength?: number;
}

export interface SettingsAgent {
  name: string;
  token: string;
  provider: SettingsProvider;
  description: string;
  workspace: string | null;
  model: string | null;
  reasoningEffort: SettingsReasoningEffort | null;
  permissionLevel: "restricted" | "standard" | "privileged" | "admin";
  sessionPolicy?: SettingsSessionPolicy;
  metadata?: Record<string, unknown>;
  bindings: SettingsBinding[];
}

export interface SettingsRuntime {
  sessionConcurrency?: {
    perAgent?: number;
    global?: number;
  };
  sessionHandoff?: {
    recentDays?: number;
    perSessionMaxChars?: number;
    maxRetries?: number;
  };
  deployment?: {
    mode: "docker" | "pm2";
    outputDir: string;
  };
}

export interface SettingsProviderCliConfig {
  env?: Record<string, string>;
}

export interface SettingsProviderCli {
  claude?: SettingsProviderCliConfig;
  codex?: SettingsProviderCliConfig;
}

export interface Settings {
  version: typeof SETTINGS_VERSION;
  timezone: string;
  permissionPolicy: PermissionPolicy;
  tokens: UserPermissionPolicy["tokens"];
  providerCli?: SettingsProviderCli;
  runtime?: SettingsRuntime;
  agents: SettingsAgent[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsolutePathCrossPlatform(value: string): boolean {
  // Accept both host-native and Windows absolute paths so a shared settings.json
  // can be validated on either side of a mixed Windows+Linux runtime setup.
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function fail(fieldPath: string, message: string): never {
  throw new Error(`Invalid settings (${fieldPath}): ${message}`);
}

function parseEnvMap(raw: unknown, fieldPath: string): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) {
    fail(fieldPath, "must be an object");
  }

  const env: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== "string") {
      fail(`${fieldPath}.${key}`, "must be a string");
    }
    env[key] = rawValue;
  }

  return Object.keys(env).length > 0 ? env : undefined;
}

function parseProviderCli(raw: unknown): Settings["providerCli"] {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) {
    fail("providerCli", "must be an object");
  }

  const next: SettingsProviderCli = {};
  for (const provider of ["claude", "codex"] as const) {
    const providerRaw = raw[provider];
    if (providerRaw === undefined || providerRaw === null) continue;
    if (!isObject(providerRaw)) {
      fail(`providerCli.${provider}`, "must be an object");
    }

    const env = parseEnvMap(providerRaw.env, `providerCli.${provider}.env`);
    if (env) {
      next[provider] = { env };
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeOperations(operations: Record<string, PermissionLevel>): Record<string, PermissionLevel> {
  const normalized: Record<string, PermissionLevel> = {};
  for (const [key, value] of Object.entries(operations)) {
    if (typeof key !== "string" || key.trim() === "") {
      fail("permission-policy", "contains invalid operation key");
    }
    if (!isPermissionLevel(value)) {
      fail(`permission-policy.${key}`, "must be restricted|standard|privileged|admin");
    }
    normalized[key] = value;
  }
  return normalized;
}

function parsePermissionPolicy(raw: unknown): Settings["permissionPolicy"] {
  if (!isObject(raw)) {
    fail("permission-policy", "must be an object");
  }
  return {
    operations: normalizeOperations(raw as Record<string, PermissionLevel>),
  };
}

function parseTokenPolicy(raw: unknown): Settings["tokens"] {
  if (!Array.isArray(raw)) {
    fail("tokens", "must be an array");
  }

  try {
    return parseUserPermissionPolicyFromObject({ tokens: raw }).tokens;
  } catch (err) {
    fail("tokens", (err as Error).message);
  }
}

function parseTimezone(raw: unknown): string {
  const timezone = typeof raw === "string" ? raw.trim() : "";
  if (!timezone || !isValidIanaTimeZone(timezone)) {
    fail("timezone", "must be a valid IANA timezone");
  }
  return timezone;
}

function parsePositiveInt(
  value: unknown,
  fieldPath: string,
  defaultValue: number,
  range: { min: number; max: number }
): number {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(fieldPath, "must be a number");
  }
  const n = Math.trunc(value);
  if (n < range.min || n > range.max) {
    fail(fieldPath, `must be between ${range.min} and ${range.max}`);
  }
  return n;
}

function parseRuntime(raw: unknown): SettingsRuntime {
  if (raw === undefined || raw === null) {
    return {
      sessionConcurrency: {
        perAgent: DEFAULT_SESSION_CONCURRENCY_PER_AGENT,
        global: DEFAULT_SESSION_CONCURRENCY_GLOBAL,
      },
      sessionHandoff: {
        recentDays: DEFAULT_SESSION_HANDOFF_RECENT_DAYS,
        perSessionMaxChars: DEFAULT_SESSION_HANDOFF_PER_SESSION_MAX_CHARS,
        maxRetries: DEFAULT_SESSION_HANDOFF_MAX_RETRIES,
      },
    };
  }

  if (!isObject(raw)) {
    fail("runtime", "must be an object");
  }

  const concurrencyRaw = raw["session-concurrency"];
  if (concurrencyRaw !== undefined && !isObject(concurrencyRaw)) {
    fail("runtime.session-concurrency", "must be an object");
  }

  const perAgent = parsePositiveInt(
    concurrencyRaw ? concurrencyRaw["per-agent"] : undefined,
    "runtime.session-concurrency.per-agent",
    DEFAULT_SESSION_CONCURRENCY_PER_AGENT,
    { min: 1, max: 64 }
  );
  const globalLimit = parsePositiveInt(
    concurrencyRaw ? concurrencyRaw.global : undefined,
    "runtime.session-concurrency.global",
    DEFAULT_SESSION_CONCURRENCY_GLOBAL,
    { min: 1, max: 256 }
  );

  const handoffRaw = raw["session-handoff"];
  if (handoffRaw !== undefined && !isObject(handoffRaw)) {
    fail("runtime.session-handoff", "must be an object");
  }

  const handoffRecentDays = parsePositiveInt(
    handoffRaw ? handoffRaw["recent-days"] : undefined,
    "runtime.session-handoff.recent-days",
    DEFAULT_SESSION_HANDOFF_RECENT_DAYS,
    { min: 1, max: 30 },
  );
  const handoffPerSessionMaxChars = parsePositiveInt(
    handoffRaw ? handoffRaw["per-session-max-chars"] : undefined,
    "runtime.session-handoff.per-session-max-chars",
    DEFAULT_SESSION_HANDOFF_PER_SESSION_MAX_CHARS,
    { min: 1_000, max: 1_000_000 },
  );
  const handoffMaxRetries = parsePositiveInt(
    handoffRaw ? handoffRaw["max-retries"] : undefined,
    "runtime.session-handoff.max-retries",
    DEFAULT_SESSION_HANDOFF_MAX_RETRIES,
    { min: 0, max: 20 },
  );

  const deploymentRaw = raw.deployment;
  let deployment: SettingsRuntime["deployment"];
  if (deploymentRaw !== undefined) {
    if (!isObject(deploymentRaw)) {
      fail("runtime.deployment", "must be an object");
    }
    const modeRaw = typeof deploymentRaw.mode === "string" ? deploymentRaw.mode.trim().toLowerCase() : "";
    if (modeRaw !== "docker" && modeRaw !== "pm2") {
      fail("runtime.deployment.mode", "must be docker or pm2");
    }
    const outputDirRaw =
      typeof deploymentRaw["output-dir"] === "string"
        ? deploymentRaw["output-dir"]
        : typeof deploymentRaw.outputDir === "string"
          ? deploymentRaw.outputDir
          : "";
    const outputDir = outputDirRaw.trim();
    if (!outputDir) {
      fail("runtime.deployment.output-dir", "must be a non-empty path");
    }
    if (!isAbsolutePathCrossPlatform(outputDir)) {
      fail("runtime.deployment.output-dir", "must be an absolute path");
    }
    deployment = {
      mode: modeRaw,
      outputDir,
    };
  }

  return {
    sessionConcurrency: {
      perAgent,
      global: globalLimit,
    },
    sessionHandoff: {
      recentDays: handoffRecentDays,
      perSessionMaxChars: handoffPerSessionMaxChars,
      maxRetries: handoffMaxRetries,
    },
    ...(deployment ? { deployment } : {}),
  };
}

function parseSessionPolicy(raw: unknown, agentName: string): SettingsSessionPolicy | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    fail(`agents[${agentName}].session-policy`, "must be an object");
  }

  const next: SettingsSessionPolicy = {};

  if (raw["daily-reset-at"] !== undefined) {
    if (typeof raw["daily-reset-at"] !== "string") {
      fail(`agents[${agentName}].session-policy.daily-reset-at`, "must be a string");
    }
    next.dailyResetAt = parseDailyResetAt(raw["daily-reset-at"]).normalized;
  }

  if (raw["idle-timeout"] !== undefined) {
    if (typeof raw["idle-timeout"] !== "string") {
      fail(`agents[${agentName}].session-policy.idle-timeout`, "must be a string");
    }
    parseDurationToMs(raw["idle-timeout"]);
    next.idleTimeout = raw["idle-timeout"].trim();
  }

  if (raw["max-context-length"] !== undefined) {
    if (typeof raw["max-context-length"] !== "number" || !Number.isFinite(raw["max-context-length"])) {
      fail(`agents[${agentName}].session-policy.max-context-length`, "must be a number");
    }
    if (raw["max-context-length"] <= 0) {
      fail(`agents[${agentName}].session-policy.max-context-length`, "must be > 0");
    }
    next.maxContextLength = Math.trunc(raw["max-context-length"]);
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function parseBindings(raw: unknown, agentName: string): SettingsBinding[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    fail(`agents[${agentName}].bindings`, "must be an array");
  }

  const bindings = raw.map((value, index) => {
    if (!isObject(value)) {
      fail(`agents[${agentName}].bindings[${index}]`, "must be an object");
    }
    const adapterType = typeof value["adapter-type"] === "string" ? value["adapter-type"].trim() : "";
    if (!adapterType) {
      fail(`agents[${agentName}].bindings[${index}].adapter-type`, "is required");
    }
    const adapterToken = typeof value["adapter-token"] === "string" ? value["adapter-token"].trim() : "";
    if (!adapterToken) {
      fail(`agents[${agentName}].bindings[${index}].adapter-token`, "is required");
    }
    return { adapterType, adapterToken };
  });

  const seenByType = new Set<string>();
  for (const binding of bindings) {
    if (seenByType.has(binding.adapterType)) {
      fail(`agents[${agentName}].bindings`, `duplicate adapter type '${binding.adapterType}'`);
    }
    seenByType.add(binding.adapterType);
  }

  return bindings;
}

function parseAgent(raw: unknown, index: number): SettingsAgent {
  if (!isObject(raw)) {
    fail(`agents[${index}]`, "must be an object");
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || !isValidAgentName(name)) {
    fail(`agents[${index}].name`, AGENT_NAME_ERROR_MESSAGE);
  }

  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  if (!token) {
    fail(`agents[${index}].token`, "is required");
  }
  if (!AGENT_TOKEN_REGEX.test(token)) {
    fail(`agents[${index}].token`, "must be 32 lowercase hex characters");
  }

  const provider = raw.provider;
  if (provider !== "claude" && provider !== "codex") {
    fail(`agents[${index}].provider`, "must be claude or codex");
  }

  const description = typeof raw.description === "string" ? raw.description : "";

  let workspace: string | null = null;
  if (raw.workspace === null || raw.workspace === undefined) {
    workspace = null;
  } else if (typeof raw.workspace === "string") {
    const trimmed = raw.workspace.trim();
    if (!trimmed) {
      workspace = null;
    } else if (!path.isAbsolute(trimmed)) {
      fail(`agents[${index}].workspace`, "must be an absolute path when set");
    } else {
      workspace = trimmed;
    }
  } else {
    fail(`agents[${index}].workspace`, "must be string|null");
  }

  const modelRaw = raw.model;
  let model: string | null = null;
  if (modelRaw === null || modelRaw === undefined) {
    model = null;
  } else if (typeof modelRaw === "string") {
    model = modelRaw.trim() || null;
  } else {
    fail(`agents[${index}].model`, "must be string|null");
  }

  const reasoningRaw = raw["reasoning-effort"];
  let reasoningEffort: SettingsReasoningEffort | null = null;
  if (reasoningRaw === null || reasoningRaw === undefined || reasoningRaw === "default") {
    reasoningEffort = null;
  } else if (
    reasoningRaw === "none" ||
    reasoningRaw === "low" ||
    reasoningRaw === "medium" ||
    reasoningRaw === "high" ||
    reasoningRaw === "xhigh"
  ) {
    reasoningEffort = reasoningRaw;
  } else {
    fail(`agents[${index}].reasoning-effort`, "must be none|low|medium|high|xhigh|default|null");
  }

  const permissionRaw = raw["permission-level"];
  const permissionLevel = permissionRaw === undefined ? DEFAULT_SETUP_PERMISSION_LEVEL : permissionRaw;
  if (!isPermissionLevel(permissionLevel)) {
    fail(`agents[${index}].permission-level`, "must be restricted|standard|privileged|admin");
  }

  const metadataRaw = raw.metadata;
  if (metadataRaw !== undefined && !isObject(metadataRaw)) {
    fail(`agents[${index}].metadata`, "must be an object");
  }

  const sessionPolicy = parseSessionPolicy(raw["session-policy"], name);
  const bindings = parseBindings(raw.bindings, name);

  return {
    name,
    token,
    provider,
    description,
    workspace,
    model,
    reasoningEffort,
    permissionLevel,
    sessionPolicy,
    metadata: metadataRaw,
    bindings,
  };
}

export function assertValidSettings(settings: Settings): void {
  if (!settings.timezone || !isValidIanaTimeZone(settings.timezone)) {
    fail("timezone", "must be a valid IANA timezone");
  }
  try {
    parseUserPermissionPolicyFromObject({ tokens: settings.tokens });
  } catch (err) {
    fail("tokens", (err as Error).message);
  }
  settings.permissionPolicy = {
    operations: normalizeOperations(settings.permissionPolicy.operations),
  };
  settings.providerCli = parseProviderCli(settings.providerCli);
  const perAgent = settings.runtime?.sessionConcurrency?.perAgent ?? DEFAULT_SESSION_CONCURRENCY_PER_AGENT;
  const globalLimit = settings.runtime?.sessionConcurrency?.global ?? DEFAULT_SESSION_CONCURRENCY_GLOBAL;
  if (!Number.isFinite(perAgent) || Math.trunc(perAgent) < 1 || Math.trunc(perAgent) > 64) {
    fail("runtime.session-concurrency.per-agent", "must be between 1 and 64");
  }
  if (!Number.isFinite(globalLimit) || Math.trunc(globalLimit) < 1 || Math.trunc(globalLimit) > 256) {
    fail("runtime.session-concurrency.global", "must be between 1 and 256");
  }
  if (Math.trunc(globalLimit) < Math.trunc(perAgent)) {
    fail("runtime.session-concurrency.global", "must be >= runtime.session-concurrency.per-agent");
  }
  const handoffRecentDays = settings.runtime?.sessionHandoff?.recentDays ?? DEFAULT_SESSION_HANDOFF_RECENT_DAYS;
  const handoffPerSessionMaxChars =
    settings.runtime?.sessionHandoff?.perSessionMaxChars ?? DEFAULT_SESSION_HANDOFF_PER_SESSION_MAX_CHARS;
  const handoffMaxRetries =
    settings.runtime?.sessionHandoff?.maxRetries ?? DEFAULT_SESSION_HANDOFF_MAX_RETRIES;
  if (!Number.isFinite(handoffRecentDays) || Math.trunc(handoffRecentDays) < 1 || Math.trunc(handoffRecentDays) > 30) {
    fail("runtime.session-handoff.recent-days", "must be between 1 and 30");
  }
  if (
    !Number.isFinite(handoffPerSessionMaxChars) ||
    Math.trunc(handoffPerSessionMaxChars) < 1000 ||
    Math.trunc(handoffPerSessionMaxChars) > 1_000_000
  ) {
    fail("runtime.session-handoff.per-session-max-chars", "must be between 1000 and 1000000");
  }
  if (!Number.isFinite(handoffMaxRetries) || Math.trunc(handoffMaxRetries) < 0 || Math.trunc(handoffMaxRetries) > 20) {
    fail("runtime.session-handoff.max-retries", "must be between 0 and 20");
  }
  const deploymentMode = settings.runtime?.deployment?.mode;
  const deploymentOutputDir = settings.runtime?.deployment?.outputDir?.trim() ?? "";
  if (deploymentMode !== undefined && deploymentMode !== "docker" && deploymentMode !== "pm2") {
    fail("runtime.deployment.mode", "must be docker or pm2");
  }
  if (deploymentMode !== undefined) {
    if (!deploymentOutputDir) {
      fail("runtime.deployment.output-dir", "must be a non-empty path");
    }
    if (!isAbsolutePathCrossPlatform(deploymentOutputDir)) {
      fail("runtime.deployment.output-dir", "must be an absolute path");
    }
  }

  const byName = new Set<string>();
  const byToken = new Set<string>();
  const bindingIdentity = new Set<string>();

  for (const agent of settings.agents) {
    const loweredName = agent.name.toLowerCase();
    if (byName.has(loweredName)) {
      fail("agents", `duplicate agent name '${agent.name}'`);
    }
    byName.add(loweredName);

    if (byToken.has(agent.token)) {
      fail("agents", `duplicate agent token for '${agent.name}'`);
    }
    if (!AGENT_TOKEN_REGEX.test(agent.token)) {
      fail(`agents[${agent.name}]`, "token must be 32 lowercase hex characters");
    }
    byToken.add(agent.token);

    for (const binding of agent.bindings) {
      const key = `${binding.adapterType}\u0000${binding.adapterToken}`;
      if (bindingIdentity.has(key)) {
        fail("agents", `duplicate adapter binding '${binding.adapterType}' token across agents`);
      }
      bindingIdentity.add(key);
    }

  }

}

export function parseSettingsJson(json: string): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Invalid settings JSON");
  }

  if (!isObject(raw)) {
    fail("root", "must be an object");
  }

  if (raw.version !== SETTINGS_VERSION) {
    fail("version", `expected ${SETTINGS_VERSION}`);
  }

  const agentsRaw = raw.agents;
  if (!Array.isArray(agentsRaw) || agentsRaw.length < 1) {
    fail("agents", "must be a non-empty array");
  }

  const settings: Settings = {
    version: SETTINGS_VERSION,
    timezone: parseTimezone(raw.timezone),
    permissionPolicy: parsePermissionPolicy(raw["permission-policy"] ?? undefined),
    tokens: parseTokenPolicy(raw.tokens),
    providerCli: parseProviderCli(raw.providerCli ?? raw["provider-cli"]),
    runtime: parseRuntime(raw.runtime),
    agents: agentsRaw.map((agent, index) => parseAgent(agent, index)),
  };

  assertValidSettings(settings);
  return settings;
}

export function stringifySettings(settings: Settings): string {
  assertValidSettings(settings);
  const providerCli = settings.providerCli;
  return `${JSON.stringify({
    version: SETTINGS_VERSION,
    timezone: settings.timezone,
    "permission-policy": settings.permissionPolicy.operations,
    tokens: settings.tokens.map((token) => ({
      name: token.name,
      token: token.token,
      role: token.role,
      ...(token.agents ? { agents: token.agents } : {}),
      ...(token.bindings && token.bindings.length > 0
        ? {
            bindings: token.bindings.map((binding) => ({
              "adapter-type": binding.adapterType,
              uid: binding.uid,
            })),
          }
        : {}),
    })),
    runtime: {
      "session-concurrency": {
        "per-agent":
          settings.runtime?.sessionConcurrency?.perAgent ?? DEFAULT_SESSION_CONCURRENCY_PER_AGENT,
        global: settings.runtime?.sessionConcurrency?.global ?? DEFAULT_SESSION_CONCURRENCY_GLOBAL,
      },
      "session-handoff": {
        "recent-days":
          settings.runtime?.sessionHandoff?.recentDays ?? DEFAULT_SESSION_HANDOFF_RECENT_DAYS,
        "per-session-max-chars":
          settings.runtime?.sessionHandoff?.perSessionMaxChars ??
          DEFAULT_SESSION_HANDOFF_PER_SESSION_MAX_CHARS,
        "max-retries":
          settings.runtime?.sessionHandoff?.maxRetries ?? DEFAULT_SESSION_HANDOFF_MAX_RETRIES,
      },
      ...(settings.runtime?.deployment
        ? {
            deployment: {
              mode: settings.runtime.deployment.mode,
              "output-dir": settings.runtime.deployment.outputDir,
            },
          }
        : {}),
    },
    ...(providerCli
      ? {
          providerCli: {
            ...(providerCli.claude?.env ? { claude: { env: providerCli.claude.env } } : {}),
            ...(providerCli.codex?.env ? { codex: { env: providerCli.codex.env } } : {}),
          },
        }
      : {}),
    agents: settings.agents.map((agent) => ({
      name: agent.name,
      token: agent.token,
      provider: agent.provider,
      description: agent.description,
      workspace: agent.workspace,
      model: agent.model,
      "reasoning-effort": agent.reasoningEffort,
      "permission-level": agent.permissionLevel,
      ...(agent.sessionPolicy
        ? {
            "session-policy": {
              ...(agent.sessionPolicy.dailyResetAt !== undefined
                ? { "daily-reset-at": agent.sessionPolicy.dailyResetAt }
                : {}),
              ...(agent.sessionPolicy.idleTimeout !== undefined
                ? { "idle-timeout": agent.sessionPolicy.idleTimeout }
                : {}),
              ...(agent.sessionPolicy.maxContextLength !== undefined
                ? { "max-context-length": agent.sessionPolicy.maxContextLength }
                : {}),
            },
          }
        : {}),
      ...(agent.metadata ? { metadata: agent.metadata } : {}),
      bindings: agent.bindings.map((binding) => ({
        "adapter-type": binding.adapterType,
        "adapter-token": binding.adapterToken,
      })),
    })),
  }, null, 2)}\n`;
}
