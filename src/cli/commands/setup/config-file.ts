import * as fs from "fs";
import * as path from "path";
import { getDefaultConfig } from "../../../daemon/daemon.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../../shared/validation.js";
import { parseDailyResetAt, parseDurationToMs } from "../../../shared/session-policy.js";
import {
  DEFAULT_SETUP_AGENT_NAME,
  DEFAULT_SETUP_AUTO_LEVEL,
  DEFAULT_SETUP_MODEL_BY_PROVIDER,
  DEFAULT_SETUP_PERMISSION_LEVEL,
  DEFAULT_SETUP_PROVIDER,
  DEFAULT_SETUP_REASONING_EFFORT,
  getDefaultAgentDescription,
  getDefaultSetupBossName,
  getDefaultSetupWorkspace,
} from "../../../shared/defaults.js";
import { resolveAndValidateMemoryModel, type MemoryModelMode, type ResolvedMemoryModelConfig } from "../../memory-model.js";
import { checkSetupStatus, executeSetup, normalizeMemoryConfig } from "./core.js";
import type { SetupConfig } from "./types.js";
import { isPlainObject } from "./utils.js";

interface SetupConfigFileV1 {
  version: 1;
  "boss-name"?: string;
  "boss-timezone"?: string;
  "boss-token": string;
  provider?: "claude" | "codex";
  "provider-source-home"?: string;
  memory?: {
    mode?: "default" | "local";
    "model-path"?: string;
  };
  agent: {
    name?: string;
    description?: string;
    workspace?: string;
    model?: string | null;
    "reasoning-effort"?:
      | "none"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "default"
      | null;
    "auto-level"?: "medium" | "high";
    "permission-level"?: "restricted" | "standard" | "privileged";
    "session-policy"?: {
      "daily-reset-at"?: string;
      "idle-timeout"?: string;
      "max-context-length"?: number;
    };
    metadata?: Record<string, unknown>;
  };
  telegram: {
    "adapter-token": string;
    "adapter-boss-id": string;
  };
}

function parseSetupConfigFileV1(json: string): SetupConfig {
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
  if (version !== 1) {
    throw new Error("Invalid setup config version (expected 1)");
  }

  const bossToken = typeof parsed["boss-token"] === "string" ? parsed["boss-token"].trim() : "";
  if (!bossToken) {
    throw new Error("Invalid setup config (boss-token is required)");
  }
  if (bossToken.length < 4) {
    throw new Error("Invalid setup config (boss-token must be at least 4 characters)");
  }

  const providerRaw = parsed.provider;
  const provider =
    providerRaw === "claude" || providerRaw === "codex" ? providerRaw : DEFAULT_SETUP_PROVIDER;

  const providerSourceHomeRaw = (parsed as Record<string, unknown>)["provider-source-home"];
  let providerSourceHome: string | undefined;
  if (typeof providerSourceHomeRaw === "string" && providerSourceHomeRaw.trim()) {
    const trimmed = providerSourceHomeRaw.trim();
    if (!path.isAbsolute(trimmed) && !trimmed.startsWith("~")) {
      throw new Error("Invalid setup config (provider-source-home must be an absolute path or start with ~)");
    }
    providerSourceHome = trimmed;
  }

  const bossNameRaw = parsed["boss-name"];
  const bossName =
    typeof bossNameRaw === "string" && bossNameRaw.trim()
      ? bossNameRaw.trim()
      : getDefaultSetupBossName();

  const daemonTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const bossTimezoneRaw = (parsed as Record<string, unknown>)["boss-timezone"];
  const bossTimezone =
    typeof bossTimezoneRaw === "string" && bossTimezoneRaw.trim()
      ? bossTimezoneRaw.trim()
      : daemonTz;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: bossTimezone }).format(new Date(0));
  } catch {
    throw new Error("Invalid setup config (boss-timezone must be a valid IANA timezone)");
  }

  const agentRaw = parsed.agent;
  if (!isPlainObject(agentRaw)) {
    throw new Error("Invalid setup config (agent is required)");
  }

  const agentNameRaw = agentRaw.name;
  const agentName =
    typeof agentNameRaw === "string" && agentNameRaw.trim()
      ? agentNameRaw.trim()
      : DEFAULT_SETUP_AGENT_NAME;
  if (!isValidAgentName(agentName)) {
    throw new Error(`Invalid setup config (agent.name): ${AGENT_NAME_ERROR_MESSAGE}`);
  }

  const agentDescriptionRaw = agentRaw.description;
  const agentDescription =
    typeof agentDescriptionRaw === "string"
      ? agentDescriptionRaw
      : getDefaultAgentDescription(agentName);

  const workspaceRaw = agentRaw.workspace;
  const workspace =
    typeof workspaceRaw === "string" && workspaceRaw.trim()
      ? workspaceRaw.trim()
      : getDefaultSetupWorkspace();
  if (!path.isAbsolute(workspace)) {
    throw new Error("Invalid setup config (agent.workspace must be an absolute path)");
  }

  const modelRaw = agentRaw.model;
  const model: SetupConfig["agent"]["model"] = (() => {
    if (modelRaw === null) return null;
    if (typeof modelRaw === "string" && modelRaw.trim()) {
      const trimmed = modelRaw.trim();
      if (trimmed === "provider_default") {
        throw new Error("Invalid setup config (agent.model no longer supports 'provider_default'; use 'default' or null)");
      }
      if (trimmed === "default") return null;
      return trimmed;
    }
    return DEFAULT_SETUP_MODEL_BY_PROVIDER[provider];
  })();

  const reasoningEffortRaw = agentRaw["reasoning-effort"];
  const reasoningEffort: SetupConfig["agent"]["reasoningEffort"] = (() => {
    if (reasoningEffortRaw === null) return null;
    if (reasoningEffortRaw === "provider_default") {
      throw new Error(
        "Invalid setup config (agent.reasoning-effort no longer supports 'provider_default'; use 'default' or null)"
      );
    }
    if (reasoningEffortRaw === "default") return null;
    if (
      reasoningEffortRaw === "none" ||
      reasoningEffortRaw === "low" ||
      reasoningEffortRaw === "medium" ||
      reasoningEffortRaw === "high" ||
      reasoningEffortRaw === "xhigh"
    ) {
      return reasoningEffortRaw;
    }
    return DEFAULT_SETUP_REASONING_EFFORT;
  })();

  const autoLevelRaw = agentRaw["auto-level"];
  const autoLevel: SetupConfig["agent"]["autoLevel"] = (() => {
    if (autoLevelRaw === undefined) return DEFAULT_SETUP_AUTO_LEVEL;
    if (autoLevelRaw === "medium" || autoLevelRaw === "high") return autoLevelRaw;
    if (autoLevelRaw === "low") {
      throw new Error("Invalid setup config (agent.auto-level no longer supports 'low'; use medium or high)");
    }
    throw new Error("Invalid setup config (agent.auto-level must be 'medium' or 'high')");
  })();

  const permissionLevelRaw = agentRaw["permission-level"];
  const permissionLevel =
    permissionLevelRaw === "restricted" || permissionLevelRaw === "standard" || permissionLevelRaw === "privileged"
      ? permissionLevelRaw
      : DEFAULT_SETUP_PERMISSION_LEVEL;

  let sessionPolicy: SetupConfig["agent"]["sessionPolicy"] | undefined;
  const sessionPolicyRaw = agentRaw["session-policy"];
  if (sessionPolicyRaw !== undefined) {
    if (!isPlainObject(sessionPolicyRaw)) {
      throw new Error("Invalid setup config (agent.session-policy must be an object)");
    }

    const nextPolicy: NonNullable<SetupConfig["agent"]["sessionPolicy"]> = {};

    if (sessionPolicyRaw["daily-reset-at"] !== undefined) {
      if (typeof sessionPolicyRaw["daily-reset-at"] !== "string") {
        throw new Error("Invalid setup config (agent.session-policy.daily-reset-at must be a string)");
      }
      nextPolicy.dailyResetAt = parseDailyResetAt(sessionPolicyRaw["daily-reset-at"]).normalized;
    }
    if (sessionPolicyRaw["idle-timeout"] !== undefined) {
      if (typeof sessionPolicyRaw["idle-timeout"] !== "string") {
        throw new Error("Invalid setup config (agent.session-policy.idle-timeout must be a string)");
      }
      parseDurationToMs(sessionPolicyRaw["idle-timeout"]);
      nextPolicy.idleTimeout = sessionPolicyRaw["idle-timeout"].trim();
    }
    if (sessionPolicyRaw["max-tokens"] !== undefined) {
      throw new Error("Invalid setup config (agent.session-policy.max-tokens is no longer supported; use max-context-length)");
    }
    if (sessionPolicyRaw["max-context-length"] !== undefined) {
      if (typeof sessionPolicyRaw["max-context-length"] !== "number" || !Number.isFinite(sessionPolicyRaw["max-context-length"])) {
        throw new Error("Invalid setup config (agent.session-policy.max-context-length must be a number)");
      }
      if (sessionPolicyRaw["max-context-length"] <= 0) {
        throw new Error("Invalid setup config (agent.session-policy.max-context-length must be > 0)");
      }
      nextPolicy.maxContextLength = Math.trunc(sessionPolicyRaw["max-context-length"]);
    }

    if (Object.keys(nextPolicy).length > 0) {
      sessionPolicy = nextPolicy;
    }
  }

  const metadataRaw = agentRaw.metadata;
  let metadata: Record<string, unknown> | undefined;
  if (metadataRaw !== undefined) {
    if (!isPlainObject(metadataRaw)) {
      throw new Error("Invalid setup config (agent.metadata must be a JSON object)");
    }
    metadata = metadataRaw;
  }

  const telegramRaw = (parsed as Record<string, unknown>).telegram;
  if (!isPlainObject(telegramRaw)) {
    throw new Error("Invalid setup config (telegram is required)");
  }

  const adapterToken =
    typeof telegramRaw["adapter-token"] === "string" ? telegramRaw["adapter-token"].trim() : "";
  if (!adapterToken) {
    throw new Error("Invalid setup config (telegram.adapter-token is required)");
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(adapterToken)) {
    throw new Error("Invalid setup config (telegram.adapter-token has invalid format)");
  }

  const adapterBossIdRaw =
    typeof telegramRaw["adapter-boss-id"] === "string" ? telegramRaw["adapter-boss-id"].trim() : "";
  if (!adapterBossIdRaw) {
    throw new Error("Invalid setup config (telegram.adapter-boss-id is required)");
  }
  const adapterBossId = adapterBossIdRaw.replace(/^@/, "");

  const config: SetupConfig = {
    provider,
    providerSourceHome,
    bossName,
    bossTimezone,
    agent: {
      name: agentName,
      description: agentDescription,
      workspace,
      model,
      reasoningEffort,
      autoLevel,
      permissionLevel,
      sessionPolicy,
      metadata,
    },
    adapter: {
      adapterType: "telegram",
      adapterToken,
      adapterBossId,
    },
    bossToken,
  };

  const memoryRaw = (parsed as Record<string, unknown>).memory;
  if (isPlainObject(memoryRaw)) {
    const modeRaw = memoryRaw.mode;
    const mode: MemoryModelMode =
      modeRaw === "local" || modeRaw === "default" ? modeRaw : "default";
    const modelPathRaw = memoryRaw["model-path"];
    const modelPath =
      typeof modelPathRaw === "string" && modelPathRaw.trim() ? modelPathRaw.trim() : undefined;
    config.memorySelection = { mode, modelPath };
  }

  return config;
}

export interface ConfigFileSetupOptions {
  configFile: string;
}

export async function runConfigFileSetup(options: ConfigFileSetupOptions): Promise<void> {
  console.log("\n⚡ Running setup from config file...\n");

  // Check if setup is already complete
  let isComplete: boolean;
  try {
    isComplete = await checkSetupStatus();
  } catch (err) {
    console.error(`\n❌ Setup check failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
  if (isComplete) {
    console.log("✅ Setup is already complete!");
    console.log("\nTo start over: hiboss daemon stop && rm -rf ~/hiboss && hiboss setup\n");
    console.log("(Advanced: override the Hi-Boss dir with HIBOSS_DIR.)\n");
    return;
  }

  const filePath = path.resolve(process.cwd(), options.configFile);
  let json: string;
  try {
    json = await fs.promises.readFile(filePath, "utf-8");
  } catch (err) {
    console.error(`❌ Failed to read setup config file: ${(err as Error).message}\n`);
    process.exit(1);
  }

  let config: SetupConfig;
  try {
    config = parseSetupConfigFileV1(json);
  } catch (err) {
    console.error(`❌ ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Resolve semantic memory model from config file (best-effort; setup still completes if it fails).
  const daemonConfig = getDefaultConfig();
  const sel = config.memorySelection ?? { mode: "default" as const };
  config.memory = await resolveAndValidateMemoryModel({
    daemonDir: daemonConfig.daemonDir,
    mode: sel.mode,
    modelPath: sel.modelPath,
  });
  const memory: ResolvedMemoryModelConfig = normalizeMemoryConfig(config);

  try {
    const agentToken = await executeSetup(config);

    console.log("✅ Setup complete!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`   daemon-timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    console.log(`   boss-timezone:   ${config.bossTimezone}`);
    console.log(`   boss-name:   ${config.bossName}`);
    console.log(`   agent-name:  ${config.agent.name}`);
    console.log(`   agent-token: ${agentToken}`);
    console.log(`   boss-token:  ${config.bossToken}`);
    console.log(`   provider:    ${config.provider}`);
    console.log(
      `   model:       ${config.agent.model === null ? "(provider default)" : config.agent.model}`
    );
    console.log(`   memory-enabled: ${memory.enabled ? "true" : "false"}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("\n⚠️  Save the agent token and boss token! They won't be shown again.\n");

    console.log("📱 Telegram bot is configured. Start the daemon with:");
    console.log("   hiboss daemon start\n");
  } catch (err) {
    const error = err as Error;
    console.error(`\n❌ Setup failed: ${error.message}\n`);
    process.exit(1);
  }
}
