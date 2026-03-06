import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../../shared/validation.js";
import {
  DEFAULT_SETUP_PERMISSION_LEVEL,
  getDefaultAgentDescription,
  getDefaultSetupBossName,
  getDefaultSetupWorkspace,
} from "../../../shared/defaults.js";
import { parseDailyResetAt, parseDurationToMs } from "../../../shared/session-policy.js";
import { isAgentRole } from "../../../shared/agent-role.js";
import { resolveToken } from "../../token.js";
import type {
  SetupDeclarativeAgentConfig,
  SetupDeclarativeConfig,
  SetupDeclarativeProjectConfig,
  SetupPermissionLevel,
  SetupReasoningEffort,
} from "./types.js";
import { reconcileSetupConfig } from "./declarative.js";
import { isPlainObject } from "./utils.js";

interface SetupConfigFileV2 {
  version: 2;
  "boss-name"?: string;
  "boss-timezone"?: string;
  telegram?: {
    "adapter-boss-id": string;
  };
  adapters?: Record<string, { "adapter-boss-id": string }>;
  agents: Array<{
    name: string;
    role: "speaker" | "leader";
    provider: "claude" | "codex";
    description?: string;
    workspace?: string;
    model?: string | null;
    "reasoning-effort"?: SetupReasoningEffort | "default" | null;
    "permission-level"?: SetupPermissionLevel;
    "session-policy"?: {
      "daily-reset-at"?: string;
      "idle-timeout"?: string;
      "max-context-length"?: number;
    };
    metadata?: Record<string, unknown>;
    bindings: Array<{
      "adapter-type": string;
      "adapter-token": string;
    }>;
  }>;
  projects?: Array<{
    id: string;
    name?: string;
    root: string;
    "speaker-agent": string;
    "main-group-channel"?: string;
    leaders: Array<{
      "agent-name": string;
      capabilities?: string[];
      active?: boolean;
    }>;
  }>;
}

export interface LoadedSetupConfigFile {
  filePath: string;
  json: string;
  config: SetupDeclarativeConfig;
  fingerprint: string;
}

export function computeSetupConfigFingerprint(json: string): string {
  const normalized = json.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export async function loadSetupConfigFile(configFile: string): Promise<LoadedSetupConfigFile> {
  const filePath = path.resolve(process.cwd(), configFile);
  let json: string;
  try {
    json = await fs.promises.readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read setup config file: ${(err as Error).message}`);
  }

  let config: SetupDeclarativeConfig;
  try {
    config = parseSetupConfigFileV2(json);
  } catch (err) {
    throw new Error((err as Error).message);
  }

  return {
    filePath,
    json,
    config,
    fingerprint: computeSetupConfigFingerprint(json),
  };
}

function parseAdapterBossIds(raw: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};

  const adaptersRaw = raw.adapters;
  if (adaptersRaw !== undefined) {
    if (!isPlainObject(adaptersRaw)) {
      throw new Error("Invalid setup config (adapters must be an object)");
    }
    for (const [adapterType, adapterConfig] of Object.entries(adaptersRaw)) {
      if (!isPlainObject(adapterConfig)) {
        throw new Error(`Invalid setup config (adapters.${adapterType} must be object)`);
      }
      const adapterBossId =
        typeof adapterConfig["adapter-boss-id"] === "string"
          ? adapterConfig["adapter-boss-id"].trim()
          : "";
      if (!adapterBossId) {
        throw new Error(`Invalid setup config (${adapterType}.adapter-boss-id is required)`);
      }
      result[adapterType] = adapterType === "telegram" ? adapterBossId.replace(/^@/, "") : adapterBossId;
    }
  }

  const telegramRaw = raw.telegram;
  if (telegramRaw !== undefined) {
    if (!isPlainObject(telegramRaw)) {
      throw new Error("Invalid setup config (telegram must be an object when provided)");
    }
    const adapterBossId =
      typeof telegramRaw["adapter-boss-id"] === "string" ? telegramRaw["adapter-boss-id"].trim() : "";
    if (!adapterBossId) {
      throw new Error("Invalid setup config (telegram.adapter-boss-id is required)");
    }
    if (!result.telegram) {
      result.telegram = adapterBossId.replace(/^@/, "");
    }
  }

  if (Object.keys(result).length === 0) {
    throw new Error("Invalid setup config (at least one adapters.<type>.adapter-boss-id is required)");
  }

  return result;
}

function parseSetupPermissionLevel(raw: unknown): SetupPermissionLevel | undefined {
  if (raw === undefined) return undefined;
  if (raw === "restricted" || raw === "standard" || raw === "privileged" || raw === "boss") {
    return raw;
  }
  throw new Error("Invalid setup config (agent.permission-level must be restricted|standard|privileged|boss)");
}

function parseSetupReasoningEffort(raw: unknown): SetupReasoningEffort | null {
  if (raw === null || raw === undefined || raw === "default") return null;
  if (raw === "none" || raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh") {
    return raw;
  }
  throw new Error(
    "Invalid setup config (agent.reasoning-effort must be none|low|medium|high|xhigh|default|null)"
  );
}

function parseSetupModel(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "default") return null;
    if (trimmed === "provider_default") {
      throw new Error("Invalid setup config (agent.model no longer supports 'provider_default')");
    }
    return trimmed;
  }
  throw new Error("Invalid setup config (agent.model must be string|null)");
}

function parseSessionPolicy(raw: unknown, agentName: string): SetupDeclarativeAgentConfig["sessionPolicy"] {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid setup config (agent.session-policy for '${agentName}' must be object)`);
  }

  const next: NonNullable<SetupDeclarativeAgentConfig["sessionPolicy"]> = {};

  if (raw["daily-reset-at"] !== undefined) {
    if (typeof raw["daily-reset-at"] !== "string") {
      throw new Error(`Invalid setup config (agent.session-policy.daily-reset-at for '${agentName}')`);
    }
    next.dailyResetAt = parseDailyResetAt(raw["daily-reset-at"]).normalized;
  }

  if (raw["idle-timeout"] !== undefined) {
    if (typeof raw["idle-timeout"] !== "string") {
      throw new Error(`Invalid setup config (agent.session-policy.idle-timeout for '${agentName}')`);
    }
    parseDurationToMs(raw["idle-timeout"]);
    next.idleTimeout = raw["idle-timeout"].trim();
  }

  if ((raw as Record<string, unknown>)["max-tokens"] !== undefined) {
    throw new Error(
      `Invalid setup config (agent.session-policy.max-tokens for '${agentName}' is no longer supported; use max-context-length)`
    );
  }

  if (raw["max-context-length"] !== undefined) {
    if (typeof raw["max-context-length"] !== "number" || !Number.isFinite(raw["max-context-length"])) {
      throw new Error(`Invalid setup config (agent.session-policy.max-context-length for '${agentName}')`);
    }
    if (raw["max-context-length"] <= 0) {
      throw new Error(
        `Invalid setup config (agent.session-policy.max-context-length for '${agentName}' must be > 0)`
      );
    }
    next.maxContextLength = Math.trunc(raw["max-context-length"]);
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function parseBindings(raw: unknown, agentName: string): SetupDeclarativeAgentConfig["bindings"] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid setup config (agent.bindings for '${agentName}' must be an array)`);
  }

  return raw.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`Invalid setup config (agent.bindings[${index}] for '${agentName}' must be object)`);
    }

    const adapterType = typeof item["adapter-type"] === "string" ? item["adapter-type"].trim() : "";
    if (!adapterType) {
      throw new Error(`Invalid setup config (agent.bindings[${index}].adapter-type for '${agentName}' is required)`);
    }

    const adapterToken = typeof item["adapter-token"] === "string" ? item["adapter-token"].trim() : "";
    if (!adapterToken) {
      throw new Error(`Invalid setup config (agent.bindings[${index}].adapter-token for '${agentName}' is required)`);
    }

    return {
      adapterType,
      adapterToken,
    };
  });
}

function parseProjectLeaders(raw: unknown, projectId: string): SetupDeclarativeProjectConfig["leaders"] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid setup config (project.leaders for '${projectId}' must be an array)`);
  }

  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`Invalid setup config (project.leaders[${index}] for '${projectId}' must be object)`);
    }

    const agentName = typeof item["agent-name"] === "string" ? item["agent-name"].trim() : "";
    if (!agentName) {
      throw new Error(`Invalid setup config (project.leaders[${index}].agent-name for '${projectId}' is required)`);
    }
    const normalizedName = agentName.toLowerCase();
    if (seen.has(normalizedName)) {
      throw new Error(`Invalid setup config (duplicate project leader '${agentName}' for '${projectId}')`);
    }
    seen.add(normalizedName);

    let capabilities: string[] | undefined;
    if (item.capabilities !== undefined) {
      if (!Array.isArray(item.capabilities) || item.capabilities.some((value) => typeof value !== "string")) {
        throw new Error(
          `Invalid setup config (project.leaders[${index}].capabilities for '${projectId}' must be string array)`
        );
      }
      capabilities = Array.from(
        new Set(
          item.capabilities
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        )
      );
    }

    let active: boolean | undefined;
    if (item.active !== undefined) {
      if (typeof item.active !== "boolean") {
        throw new Error(`Invalid setup config (project.leaders[${index}].active for '${projectId}' must be boolean)`);
      }
      active = item.active;
    }

    return {
      agentName,
      capabilities,
      active,
    };
  });
}

function parseProjects(raw: unknown): SetupDeclarativeProjectConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error("Invalid setup config (projects must be an array when provided)");
  }

  const seenProjectIds = new Set<string>();
  return raw.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`Invalid setup config (projects[${index}] must be object)`);
    }

    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) {
      throw new Error(`Invalid setup config (projects[${index}].id is required)`);
    }
    const normalizedId = id.toLowerCase();
    if (seenProjectIds.has(normalizedId)) {
      throw new Error(`Invalid setup config (duplicate projects id): ${id}`);
    }
    seenProjectIds.add(normalizedId);

    const root = typeof item.root === "string" ? item.root.trim() : "";
    if (!root || !path.isAbsolute(root)) {
      throw new Error(`Invalid setup config (projects[${index}].root must be absolute path)`);
    }

    const speakerAgent = typeof item["speaker-agent"] === "string" ? item["speaker-agent"].trim() : "";
    if (!speakerAgent) {
      throw new Error(`Invalid setup config (projects[${index}].speaker-agent is required)`);
    }

    const nameRaw = typeof item.name === "string" ? item.name.trim() : "";
    const name = nameRaw || path.basename(root) || id;

    const mainGroupChannel =
      typeof item["main-group-channel"] === "string" && item["main-group-channel"].trim().length > 0
        ? item["main-group-channel"].trim()
        : undefined;

    return {
      id,
      name,
      root,
      speakerAgent,
      mainGroupChannel,
      leaders: parseProjectLeaders(item.leaders, id),
    };
  });
}

function parseSetupConfigFileV2(json: string): SetupDeclarativeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid setup config JSON");
  }

  if (!isPlainObject(parsed)) {
    throw new Error("Invalid setup config (expected object)");
  }

  const version = parsed.version;
  if (version !== 2) {
    if (version === 1) {
      throw new Error("Invalid setup config version (v1 is no longer supported; expected 2)");
    }
    throw new Error("Invalid setup config version (expected 2)");
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "boss-token")) {
    throw new Error("Invalid setup config (boss-token must not be present in v2 config file)");
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "memory")) {
    throw new Error("Invalid setup config (memory is no longer supported)");
  }

  const daemonTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const bossNameRaw = parsed["boss-name"];
  const bossName =
    typeof bossNameRaw === "string" && bossNameRaw.trim() ? bossNameRaw.trim() : getDefaultSetupBossName();
  if (!bossName) {
    throw new Error("Invalid setup config (boss-name is required)");
  }

  const bossTimezoneRaw = parsed["boss-timezone"];
  const bossTimezone =
    typeof bossTimezoneRaw === "string" && bossTimezoneRaw.trim() ? bossTimezoneRaw.trim() : daemonTz;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: bossTimezone }).format(new Date(0));
  } catch {
    throw new Error("Invalid setup config (boss-timezone must be a valid IANA timezone)");
  }

  const adapterBossIds = parseAdapterBossIds(parsed);

  const agentsRaw = parsed.agents;
  if (!Array.isArray(agentsRaw) || agentsRaw.length === 0) {
    throw new Error("Invalid setup config (agents must contain at least one agent)");
  }

  const agents: SetupDeclarativeAgentConfig[] = agentsRaw.map((agentRaw, index) => {
    if (!isPlainObject(agentRaw)) {
      throw new Error(`Invalid setup config (agents[${index}] must be object)`);
    }

    const nameRaw = typeof agentRaw.name === "string" ? agentRaw.name.trim() : "";
    if (!nameRaw || !isValidAgentName(nameRaw)) {
      throw new Error(`Invalid setup config (agents[${index}].name): ${AGENT_NAME_ERROR_MESSAGE}`);
    }

    const role = agentRaw.role;
    if (!isAgentRole(role)) {
      throw new Error(`Invalid setup config (agents[${index}].role must be speaker or leader)`);
    }

    const provider = agentRaw.provider;
    if (provider !== "claude" && provider !== "codex") {
      throw new Error(`Invalid setup config (agents[${index}].provider must be claude or codex)`);
    }

    const description =
      typeof agentRaw.description === "string"
        ? agentRaw.description
        : getDefaultAgentDescription(nameRaw);

    const workspaceRaw =
      typeof agentRaw.workspace === "string" && agentRaw.workspace.trim()
        ? agentRaw.workspace.trim()
        : getDefaultSetupWorkspace();
    if (!path.isAbsolute(workspaceRaw)) {
      throw new Error(`Invalid setup config (agents[${index}].workspace must be absolute path)`);
    }

    const metadataRaw = agentRaw.metadata;
    if (metadataRaw !== undefined && !isPlainObject(metadataRaw)) {
      throw new Error(`Invalid setup config (agents[${index}].metadata must be object)`);
    }

    return {
      name: nameRaw,
      role,
      provider,
      description,
      workspace: workspaceRaw,
      model: parseSetupModel(agentRaw.model),
      reasoningEffort: parseSetupReasoningEffort(agentRaw["reasoning-effort"]),
      permissionLevel: parseSetupPermissionLevel(agentRaw["permission-level"]) ?? DEFAULT_SETUP_PERMISSION_LEVEL,
      sessionPolicy: parseSessionPolicy(agentRaw["session-policy"], nameRaw),
      metadata: metadataRaw,
      bindings: parseBindings(agentRaw.bindings, nameRaw),
    };
  });

  return {
    version: 2,
    bossName,
    bossTimezone,
    adapterBossIds,
    agents,
    projects: parseProjects(parsed.projects),
  };
}

function listOrNone(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

export interface ConfigFileSetupOptions {
  configFile: string;
  token?: string;
  dryRun?: boolean;
}

export async function runConfigFileSetup(options: ConfigFileSetupOptions): Promise<void> {
  console.log("\n⚡ Running setup from config file...\n");

  const loaded = await (async () => {
    try {
      return await loadSetupConfigFile(options.configFile);
    } catch (err) {
      console.error(`❌ ${(err as Error).message}\n`);
      process.exit(1);
    }
  })();

  const config = loaded.config;

  const token = (() => {
    try {
      return resolveToken(options.token);
    } catch (err) {
      console.error(`❌ ${(err as Error).message}\n`);
      process.exit(1);
    }
  })();

  try {
    const result = await reconcileSetupConfig({
      config,
      token,
      dryRun: Boolean(options.dryRun),
      sourcePath: loaded.filePath,
      sourceFingerprint: loaded.fingerprint,
    });

    if (result.dryRun) {
      console.log("✅ Setup config is valid (dry run).\n");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("   dry-run: true");
      console.log(`   first-apply: ${result.diff.firstApply ? "true" : "false"}`);
      console.log(`   current-agent-count: ${result.diff.currentAgentNames.length}`);
      console.log(`   desired-agent-count: ${result.diff.desiredAgentNames.length}`);
      console.log(`   removed-agents: ${listOrNone(result.diff.removedAgentNames)}`);
      console.log(`   recreated-agents: ${listOrNone(result.diff.recreatedAgentNames)}`);
      console.log(`   new-agents: ${listOrNone(result.diff.newlyCreatedAgentNames)}`);
      console.log(`   current-binding-count: ${result.diff.currentBindingCount}`);
      console.log(`   desired-binding-count: ${result.diff.desiredBindingCount}`);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("\nApply with:");
      console.log(`   hiboss setup --config-file ${JSON.stringify(options.configFile)} --token <boss-token>\n`);
      return;
    }

    console.log("✅ Setup applied successfully!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("   dry-run: false");
    console.log(`   first-apply: ${result.diff.firstApply ? "true" : "false"}`);
    console.log(`   current-agent-count: ${result.diff.currentAgentNames.length}`);
    console.log(`   desired-agent-count: ${result.diff.desiredAgentNames.length}`);
    console.log(`   removed-agents: ${listOrNone(result.diff.removedAgentNames)}`);
    console.log(`   recreated-agents: ${listOrNone(result.diff.recreatedAgentNames)}`);
    console.log(`   new-agents: ${listOrNone(result.diff.newlyCreatedAgentNames)}`);
    console.log(`   current-binding-count: ${result.diff.currentBindingCount}`);
    console.log(`   desired-binding-count: ${result.diff.desiredBindingCount}`);
    console.log(`   generated-agent-token-count: ${result.generatedAgentTokens.length}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    for (const tokenInfo of result.generatedAgentTokens) {
      console.log(`   agent-name: ${tokenInfo.name}`);
      console.log(`   agent-role: ${tokenInfo.role}`);
      console.log(`   agent-token: ${tokenInfo.token}`);
    }

    console.log("\n⚠️  Save these agent tokens. They won't be shown again.\n");
    console.log("Start the daemon with:");
    console.log("   hiboss daemon start\n");
  } catch (err) {
    console.error(`\n❌ Setup failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
