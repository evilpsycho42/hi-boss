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
  SetupPermissionLevel,
  SetupReasoningEffort,
} from "./types.js";
import { reconcileSetupConfig } from "./declarative.js";
import { isPlainObject } from "./utils.js";

interface SetupConfigFileV2 {
  version: 2;
  "boss-name"?: string;
  "boss-timezone"?: string;
  telegram: {
    "adapter-boss-id": string;
  };
  memory: {
    enabled: boolean;
    mode: "default" | "local";
    "model-path": string;
    "model-uri": string;
    dims: number;
    "last-error": string;
  };
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

  const telegramRaw = parsed.telegram;
  if (!isPlainObject(telegramRaw)) {
    throw new Error("Invalid setup config (telegram is required)");
  }
  const adapterBossIdRaw =
    typeof telegramRaw["adapter-boss-id"] === "string" ? telegramRaw["adapter-boss-id"].trim() : "";
  if (!adapterBossIdRaw) {
    throw new Error("Invalid setup config (telegram.adapter-boss-id is required)");
  }
  const telegramBossId = adapterBossIdRaw.replace(/^@/, "");

  const memoryRaw = parsed.memory;
  if (!isPlainObject(memoryRaw)) {
    throw new Error("Invalid setup config (memory is required)");
  }

  const memoryEnabled = memoryRaw.enabled;
  if (typeof memoryEnabled !== "boolean") {
    throw new Error("Invalid setup config (memory.enabled must be boolean)");
  }

  const memoryMode = memoryRaw.mode;
  if (memoryMode !== "default" && memoryMode !== "local") {
    throw new Error("Invalid setup config (memory.mode must be default or local)");
  }

  const memoryModelPath = typeof memoryRaw["model-path"] === "string" ? memoryRaw["model-path"].trim() : "";
  const memoryModelUri = typeof memoryRaw["model-uri"] === "string" ? memoryRaw["model-uri"].trim() : "";

  if (typeof memoryRaw.dims !== "number" || !Number.isFinite(memoryRaw.dims) || memoryRaw.dims < 0) {
    throw new Error("Invalid setup config (memory.dims must be >= 0)");
  }
  const memoryDims = Math.trunc(memoryRaw.dims);

  const memoryLastError =
    typeof memoryRaw["last-error"] === "string" ? memoryRaw["last-error"].trim() : "";

  if (memoryEnabled && (!memoryModelPath || memoryDims <= 0)) {
    throw new Error("Invalid setup config (enabled memory requires model-path and dims > 0)");
  }

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
    telegramBossId,
    memory: {
      enabled: memoryEnabled,
      mode: memoryMode,
      modelPath: memoryModelPath,
      modelUri: memoryModelUri,
      dims: memoryDims,
      lastError: memoryLastError,
    },
    agents,
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

  const filePath = path.resolve(process.cwd(), options.configFile);
  let json: string;
  try {
    json = await fs.promises.readFile(filePath, "utf-8");
  } catch (err) {
    console.error(`❌ Failed to read setup config file: ${(err as Error).message}\n`);
    process.exit(1);
  }

  let config: SetupDeclarativeConfig;
  try {
    config = parseSetupConfigFileV2(json);
  } catch (err) {
    console.error(`❌ ${(err as Error).message}\n`);
    process.exit(1);
  }

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
