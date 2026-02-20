import * as fs from "node:fs";
import * as path from "node:path";
import * as lockfile from "proper-lockfile";

import { hashToken } from "../agent/auth.js";
import { BACKGROUND_AGENT_NAME, DEFAULT_PERMISSION_POLICY, DEFAULT_SETUP_PERMISSION_LEVEL } from "./defaults.js";
import { isPermissionLevel, parsePermissionPolicyV1 } from "./permissions.js";
import { parseDailyResetAt, parseDurationToMs } from "./session-policy.js";
import { isValidIanaTimeZone } from "./timezone.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "./validation.js";

export const SETTINGS_VERSION = 3 as const;
export const SETTINGS_FILENAME = "settings.json" as const;
export const SETTINGS_FILE_MODE = 0o600 as const;

export type SettingsProvider = "claude" | "codex";
export type SettingsReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export interface SettingsBindingV3 {
  adapterType: string;
  adapterToken: string;
}

export interface SettingsSessionPolicyV3 {
  dailyResetAt?: string;
  idleTimeout?: string;
  maxContextLength?: number;
}

export interface SettingsAgentV3 {
  name: string;
  token: string;
  role: "speaker" | "leader";
  provider: SettingsProvider;
  description: string;
  workspace: string | null;
  model: string | null;
  reasoningEffort: SettingsReasoningEffort | null;
  permissionLevel: "restricted" | "standard" | "privileged" | "boss";
  sessionPolicy?: SettingsSessionPolicyV3;
  metadata?: Record<string, unknown>;
  bindings: SettingsBindingV3[];
}

export interface SettingsV3 {
  version: 3;
  boss: {
    name: string;
    timezone: string;
    token: string;
  };
  telegram: {
    bossIds: string[];
  };
  permissionPolicy: {
    version: 1;
    operations: Record<string, "restricted" | "standard" | "privileged" | "boss">;
  };
  agents: SettingsAgentV3[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(fieldPath: string, message: string): never {
  throw new Error(`Invalid settings (${fieldPath}): ${message}`);
}

function normalizeBossId(raw: string): string {
  return raw.trim().replace(/^@/, "");
}

function parseBossIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    fail("telegram.boss-ids", "must be an array of strings");
  }
  const ids = raw.map((value, index) => {
    if (typeof value !== "string") {
      fail(`telegram.boss-ids[${index}]`, "must be a string");
    }
    const normalized = normalizeBossId(value);
    if (!normalized) {
      fail(`telegram.boss-ids[${index}]`, "must not be empty");
    }
    return normalized;
  });
  if (ids.length < 1) {
    fail("telegram.boss-ids", "must contain at least one boss id");
  }
  const seen = new Set<string>();
  for (const id of ids) {
    const key = id.toLowerCase();
    if (seen.has(key)) {
      fail("telegram.boss-ids", `duplicate boss id '${id}'`);
    }
    seen.add(key);
  }
  return ids;
}

function parsePermissionPolicy(raw: unknown): SettingsV3["permissionPolicy"] {
  if (!isObject(raw)) {
    fail("permission-policy", "must be an object");
  }
  try {
    const parsed = parsePermissionPolicyV1(JSON.stringify(raw));
    return parsed;
  } catch (err) {
    fail("permission-policy", (err as Error).message);
  }
}

function parseSessionPolicy(raw: unknown, agentName: string): SettingsSessionPolicyV3 | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    fail(`agents[${agentName}].session-policy`, "must be an object");
  }

  const next: SettingsSessionPolicyV3 = {};

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

function parseBindings(raw: unknown, agentName: string): SettingsBindingV3[] {
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

function parseAgent(raw: unknown, index: number): SettingsAgentV3 {
  if (!isObject(raw)) {
    fail(`agents[${index}]`, "must be an object");
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || !isValidAgentName(name)) {
    fail(`agents[${index}].name`, AGENT_NAME_ERROR_MESSAGE);
  }
  if (name.toLowerCase() === BACKGROUND_AGENT_NAME) {
    fail(`agents[${index}].name`, `reserved name '${BACKGROUND_AGENT_NAME}'`);
  }

  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  if (!token) {
    fail(`agents[${index}].token`, "is required");
  }

  const role = raw.role;
  if (role !== "speaker" && role !== "leader") {
    fail(`agents[${index}].role`, "must be speaker or leader");
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
    fail(`agents[${index}].permission-level`, "must be restricted|standard|privileged|boss");
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
    role,
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

export function assertValidSettingsV3(settings: SettingsV3): void {
  const byName = new Set<string>();
  const byToken = new Set<string>();
  const bindingIdentity = new Set<string>();

  let speakerCount = 0;
  let leaderCount = 0;

  for (const agent of settings.agents) {
    const loweredName = agent.name.toLowerCase();
    if (byName.has(loweredName)) {
      fail("agents", `duplicate agent name '${agent.name}'`);
    }
    byName.add(loweredName);

    if (byToken.has(agent.token)) {
      fail("agents", `duplicate agent token for '${agent.name}'`);
    }
    byToken.add(agent.token);

    if (agent.role === "speaker") speakerCount++;
    if (agent.role === "leader") leaderCount++;

    for (const binding of agent.bindings) {
      const key = `${binding.adapterType}\u0000${binding.adapterToken}`;
      if (bindingIdentity.has(key)) {
        fail("agents", `duplicate adapter binding '${binding.adapterType}' token across agents`);
      }
      bindingIdentity.add(key);
    }

    if (agent.role === "speaker" && agent.bindings.length < 1) {
      fail(`agents[${agent.name}]`, "speaker must have at least one binding");
    }
  }

  if (speakerCount < 1 || leaderCount < 1) {
    fail("agents", "must contain at least one speaker and one leader");
  }
}

export function parseSettingsV3Json(json: string): SettingsV3 {
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

  const bossRaw = raw.boss;
  if (!isObject(bossRaw)) {
    fail("boss", "must be an object");
  }
  const bossName = typeof bossRaw.name === "string" ? bossRaw.name.trim() : "";
  if (!bossName) fail("boss.name", "is required");

  const bossTimezone = typeof bossRaw.timezone === "string" ? bossRaw.timezone.trim() : "";
  if (!bossTimezone || !isValidIanaTimeZone(bossTimezone)) {
    fail("boss.timezone", "must be a valid IANA timezone");
  }

  const bossToken = typeof bossRaw.token === "string" ? bossRaw.token.trim() : "";
  if (bossToken.length < 4) {
    fail("boss.token", "must be at least 4 characters");
  }

  const telegramRaw = raw.telegram;
  if (!isObject(telegramRaw)) {
    fail("telegram", "must be an object");
  }

  const agentsRaw = raw.agents;
  if (!Array.isArray(agentsRaw) || agentsRaw.length < 1) {
    fail("agents", "must be a non-empty array");
  }

  const settings: SettingsV3 = {
    version: SETTINGS_VERSION,
    boss: {
      name: bossName,
      timezone: bossTimezone,
      token: bossToken,
    },
    telegram: {
      bossIds: parseBossIds(telegramRaw["boss-ids"]),
    },
    permissionPolicy: parsePermissionPolicy(raw["permission-policy"] ?? DEFAULT_PERMISSION_POLICY),
    agents: agentsRaw.map((agent, index) => parseAgent(agent, index)),
  };

  assertValidSettingsV3(settings);
  return settings;
}

export function stringifySettingsV3(settings: SettingsV3): string {
  assertValidSettingsV3(settings);
  return `${JSON.stringify({
    version: SETTINGS_VERSION,
    boss: {
      name: settings.boss.name,
      timezone: settings.boss.timezone,
      token: settings.boss.token,
    },
    telegram: {
      "boss-ids": settings.telegram.bossIds,
    },
    "permission-policy": settings.permissionPolicy,
    agents: settings.agents.map((agent) => ({
      name: agent.name,
      token: agent.token,
      role: agent.role,
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

export function getSettingsPath(hibossDir: string): string {
  return path.join(hibossDir, SETTINGS_FILENAME);
}

export function ensureSettingsFileMode(filePath: string): void {
  try {
    fs.chmodSync(filePath, SETTINGS_FILE_MODE);
  } catch {
    // Best-effort across platforms.
  }
}

export function readSettingsFile(hibossDir: string): SettingsV3 {
  const settingsPath = getSettingsPath(hibossDir);
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Settings file not found: ${settingsPath}`);
  }
  const json = fs.readFileSync(settingsPath, "utf8");
  const settings = parseSettingsV3Json(json);
  ensureSettingsFileMode(settingsPath);
  return settings;
}

export async function writeSettingsFileAtomic(hibossDir: string, settings: SettingsV3): Promise<void> {
  const settingsPath = getSettingsPath(hibossDir);
  const tmpPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  const json = stringifySettingsV3(settings);

  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.promises.writeFile(tmpPath, json, {
    encoding: "utf8",
    mode: SETTINGS_FILE_MODE,
  });
  await fs.promises.rename(tmpPath, settingsPath);
  ensureSettingsFileMode(settingsPath);
}

export async function withSettingsLock<T>(hibossDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${getSettingsPath(hibossDir)}.lock`;
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  if (!fs.existsSync(lockPath)) {
    fs.writeFileSync(lockPath, "", { encoding: "utf8", mode: SETTINGS_FILE_MODE });
  }

  const release = await lockfile.lock(lockPath, {
    stale: 10000,
    update: 5000,
    retries: {
      retries: 10,
      minTimeout: 50,
      maxTimeout: 300,
    },
  });

  try {
    return await fn();
  } finally {
    await release().catch(() => undefined);
  }
}

export function normalizeBossIds(ids: string[]): string[] {
  return ids.map(normalizeBossId).filter((value) => value.length > 0);
}

export function toBossTokenHash(settings: SettingsV3): string {
  return hashToken(settings.boss.token);
}
