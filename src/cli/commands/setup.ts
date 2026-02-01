import * as fs from "fs";
import * as path from "path";
import { input, select, password } from "@inquirer/prompts";
import { IpcClient } from "../ipc-client.js";
import { getSocketPath, getDefaultConfig, isDaemonRunning } from "../../daemon/daemon.js";
import { HiBossDatabase } from "../../daemon/db/database.js";
import { setupAgentHome } from "../../agent/home-setup.js";
import type { SetupCheckResult, SetupExecuteResult } from "../../daemon/ipc/types.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../shared/validation.js";
import { resolveAndValidateMemoryModel, type MemoryModelMode, type ResolvedMemoryModelConfig } from "../memory-model.js";
import { parseDailyResetAt, parseDurationToMs } from "../../shared/session-policy.js";
import {
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_SETUP_AGENT_NAME,
  DEFAULT_SETUP_AUTO_LEVEL,
  DEFAULT_SETUP_MODEL_BY_PROVIDER,
  DEFAULT_SETUP_PROVIDER,
  DEFAULT_SETUP_REASONING_EFFORT,
  SETUP_MODEL_CHOICES_BY_PROVIDER,
  getDefaultSetupAgentDescription,
  getDefaultSetupBossName,
  getDefaultSetupWorkspace,
} from "../../shared/defaults.js";

/**
 * Options for default setup.
 */
export interface DefaultSetupOptions {
  config: string;
}

/**
 * Setup configuration collected from user.
 */
interface SetupConfig {
  provider: 'claude' | 'codex';
  bossName: string;
  agent: {
    name: string;
    description?: string;
    workspace: string;
    model: string | null;
    reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | null;
    autoLevel: 'medium' | 'high';
    permissionLevel?: 'restricted' | 'standard' | 'privileged';
    sessionPolicy?: {
      dailyResetAt?: string;
      idleTimeout?: string;
      maxTokens?: number;
    };
    metadata?: Record<string, unknown>;
  };
  adapter: {
    adapterType: string;
    adapterToken: string;
    adapterBossId: string;
  };
  bossToken: string;
  memory?: ResolvedMemoryModelConfig;
  memorySelection?: { mode: MemoryModelMode; modelPath?: string };
}

interface SetupConfigFileV1 {
  version: 1;
  "boss-name"?: string;
  "boss-token": string;
  provider?: "claude" | "codex";
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
      "max-tokens"?: number;
    };
    metadata?: Record<string, unknown>;
  };
  telegram: {
    "adapter-token": string;
    "adapter-boss-id": string;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  const bossNameRaw = parsed["boss-name"];
  const bossName =
    typeof bossNameRaw === "string" && bossNameRaw.trim() ? bossNameRaw.trim() : getDefaultSetupBossName();

  const agentRaw = parsed.agent;
  if (!isPlainObject(agentRaw)) {
    throw new Error("Invalid setup config (agent is required)");
  }

  const agentNameRaw = agentRaw.name;
  const agentName =
    typeof agentNameRaw === "string" && agentNameRaw.trim() ? agentNameRaw.trim() : DEFAULT_SETUP_AGENT_NAME;
  if (!isValidAgentName(agentName)) {
    throw new Error(`Invalid setup config (agent.name): ${AGENT_NAME_ERROR_MESSAGE}`);
  }

  const agentDescriptionRaw = agentRaw.description;
  const agentDescription =
    typeof agentDescriptionRaw === "string" ? agentDescriptionRaw : getDefaultSetupAgentDescription(agentName);

  const workspaceRaw = agentRaw.workspace;
  const workspace =
    typeof workspaceRaw === "string" && workspaceRaw.trim() ? workspaceRaw.trim() : getDefaultSetupWorkspace();
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
      : undefined;

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
      if (typeof sessionPolicyRaw["max-tokens"] !== "number" || !Number.isFinite(sessionPolicyRaw["max-tokens"])) {
        throw new Error("Invalid setup config (agent.session-policy.max-tokens must be a number)");
      }
      if (sessionPolicyRaw["max-tokens"] <= 0) {
        throw new Error("Invalid setup config (agent.session-policy.max-tokens must be > 0)");
      }
      nextPolicy.maxTokens = Math.trunc(sessionPolicyRaw["max-tokens"]);
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
    bossName,
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
    const modelPath = typeof modelPathRaw === "string" && modelPathRaw.trim() ? modelPathRaw.trim() : undefined;
    config.memorySelection = { mode, modelPath };
  }

  return config;
}

function normalizeMemoryConfig(config: SetupConfig): ResolvedMemoryModelConfig {
  return (
    config.memory ?? {
      enabled: false,
      mode: "default",
      modelPath: "",
      modelUri: "",
      dims: 0,
      lastError: "Memory model is not configured",
    }
  );
}

/**
 * Check if setup is complete (tries IPC first, falls back to direct DB).
 */
async function checkSetupStatus(): Promise<boolean> {
  // Try IPC first (daemon running)
  try {
    const client = new IpcClient(getSocketPath());
    const result = await client.call<SetupCheckResult>("setup.check");
    return result.completed;
  } catch (err) {
    if (await isDaemonRunning()) {
      throw new Error(`Failed to check setup via daemon: ${(err as Error).message}`);
    }

    // Daemon not running, check database directly
    const config = getDefaultConfig();
    const dbPath = path.join(config.dataDir, "hiboss.db");
    const db = new HiBossDatabase(dbPath);
    try {
      return db.isSetupComplete();
    } finally {
      db.close();
    }
  }
}

/**
 * Execute setup (tries IPC first, falls back to direct DB).
 */
async function executeSetup(config: SetupConfig): Promise<string> {
  const memory = normalizeMemoryConfig(config);

  // Try IPC first (daemon running)
  try {
    const client = new IpcClient(getSocketPath());
    const result = await client.call<SetupExecuteResult>("setup.execute", {
      provider: config.provider,
      bossName: config.bossName,
      agent: config.agent,
      bossToken: config.bossToken,
      adapter: config.adapter,
      memory,
    });
    return result.agentToken;
  } catch (err) {
    if (await isDaemonRunning()) {
      throw new Error(`Failed to run setup via daemon: ${(err as Error).message}`);
    }

    // Daemon not running, execute directly on database
    return executeSetupDirect(config);
  }
}

function writeMemoryConfigToDb(db: HiBossDatabase, memory: ResolvedMemoryModelConfig): void {
  db.setConfig("memory_enabled", memory.enabled ? "true" : "false");
  db.setConfig("memory_model_source", memory.mode);
  db.setConfig("memory_model_uri", memory.modelUri ?? "");
  db.setConfig("memory_model_path", memory.modelPath ?? "");
  db.setConfig("memory_model_dims", String(memory.dims ?? 0));
  db.setConfig("memory_model_last_error", memory.lastError ?? "");
}

/**
 * Execute setup directly on the database (when daemon is not running).
 */
async function executeSetupDirect(config: SetupConfig): Promise<string> {
  const daemonConfig = getDefaultConfig();
  const dbPath = path.join(daemonConfig.dataDir, "hiboss.db");
  const db = new HiBossDatabase(dbPath);

  try {
    // Check if setup is already complete
    if (db.isSetupComplete()) {
      throw new Error("Setup already completed");
    }

    // Setup agent home directories
    await setupAgentHome(config.agent.name, daemonConfig.dataDir);

    const memory = normalizeMemoryConfig(config);

    const result = db.runInTransaction(() => {
      // Set boss name
      db.setBossName(config.bossName);

      // Set default provider
      db.setDefaultProvider(config.provider);

      writeMemoryConfigToDb(db, memory);

      // Create the first agent
      const agentResult = db.registerAgent({
        name: config.agent.name,
        description: config.agent.description,
        workspace: config.agent.workspace,
        provider: config.provider,
        model: config.agent.model,
        reasoningEffort: config.agent.reasoningEffort,
        autoLevel: config.agent.autoLevel,
        permissionLevel: config.agent.permissionLevel,
        sessionPolicy: config.agent.sessionPolicy,
        metadata: config.agent.metadata,
      });

      // Create adapter binding if provided
      db.createBinding(config.agent.name, config.adapter.adapterType, config.adapter.adapterToken);

      // Store boss ID for this adapter
      db.setAdapterBossId(config.adapter.adapterType, config.adapter.adapterBossId);

      // Set boss token
      db.setBossToken(config.bossToken);

      // Mark setup as complete
      db.markSetupComplete();

      return agentResult;
    });

    return result.token;
  } finally {
    db.close();
  }
}

/**
 * Run interactive setup.
 */
export async function runInteractiveSetup(): Promise<void> {
  console.log("\n🚀 Hi-Boss Setup Wizard\n");
  console.log("This wizard will help you configure Hi-Boss for first use.\n");

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
    console.log("\nTo start over: hiboss daemon stop && rm -rf ~/.hiboss && hiboss setup\n");
    return;
  }

  // Step 1: Choose provider
  const provider = await select<'claude' | 'codex'>({
    message: "Choose your default AI provider:",
    choices: [
      { value: 'claude', name: "Claude Code (Anthropic)" },
      { value: 'codex', name: "Codex (OpenAI)" },
    ],
  });

  // Step 2: Boss name
  const bossName = await input({
    message: "Your name (how the agent should address you):",
    default: getDefaultSetupBossName(),
    validate: (value) => {
      if (value.trim().length === 0) {
        return "Boss name cannot be empty";
      }
      return true;
    },
  });

  // Step 3: Create first agent
  console.log("\n📦 Create your first agent\n");

  const agentName = (await input({
    message: "Agent name (slug):",
    default: DEFAULT_SETUP_AGENT_NAME,
    validate: (value) => {
      const name = value.trim();
      if (!isValidAgentName(name)) {
        return AGENT_NAME_ERROR_MESSAGE;
      }
      return true;
    },
  })).trim();

  const agentDescription = await input({
    message: "Agent description (shown to other agents):",
    default: getDefaultSetupAgentDescription(agentName),
  });

  const workspace = await input({
    message: "Workspace directory:",
    default: getDefaultSetupWorkspace(),
    validate: (value) => {
      if (!path.isAbsolute(value)) {
        return "Please provide an absolute path";
      }
      return true;
    },
  });

  // Model selection based on provider
  const MODEL_PROVIDER_DEFAULT = "default";
  const MODEL_CUSTOM = "__custom__";

  const modelChoice = await select<string>({
    message: "Select model:",
    choices: [
      { value: MODEL_PROVIDER_DEFAULT, name: "default (use provider default; do not override)" },
      ...(provider === "claude"
        ? SETUP_MODEL_CHOICES_BY_PROVIDER.claude.map((value) => ({
          value,
          name: value,
        }))
        : SETUP_MODEL_CHOICES_BY_PROVIDER.codex.map((value) => ({
          value,
          name: value,
        }))),
      { value: MODEL_CUSTOM, name: "Custom model id..." },
    ],
    default: DEFAULT_SETUP_MODEL_BY_PROVIDER[provider],
  });

  let model: string | null;
  if (modelChoice === MODEL_PROVIDER_DEFAULT) {
    model = null;
  } else if (modelChoice === MODEL_CUSTOM) {
    const customModel = (await input({
      message: "Custom model id:",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return "Model id cannot be empty";
        if (trimmed === "provider_default") return "Use 'default' to clear; or enter a real model id";
        return true;
      },
    })).trim();
    model = customModel === "default" ? null : customModel;
  } else {
    model = modelChoice;
  }

  const reasoningEffortChoice = await select<
    "default" | "none" | "low" | "medium" | "high" | "xhigh"
  >({
    message: "Reasoning effort:",
    choices: [
      { value: "default", name: "default (use provider default; do not override)" },
      { value: 'none', name: "None - No reasoning (fastest)" },
      { value: 'low', name: "Low - Quick responses" },
      { value: 'medium', name: "Medium - Balanced (recommended)" },
      { value: 'high', name: "High - Thorough analysis" },
      { value: 'xhigh', name: "XHigh - Extra thorough (slowest)" },
    ],
    default: DEFAULT_SETUP_REASONING_EFFORT,
  });
  const reasoningEffort: SetupConfig["agent"]["reasoningEffort"] =
    reasoningEffortChoice === "default" ? null : reasoningEffortChoice;

  console.log("\n📊 Auto-level controls the agent sandbox:");
  console.log("   • Medium: Workspace-scoped (can write workspace + additional dirs; runs many commands)");
  console.log("   • High: Full computer access (can run almost anything)\n");

  const autoLevel = await select<'medium' | 'high'>({
    message: "Auto-level:",
    choices: [
      { value: 'high', name: "High - Full access (recommended)" },
      { value: 'medium', name: "Medium - Workspace-scoped" },
    ],
    default: DEFAULT_SETUP_AUTO_LEVEL,
  });

  const permissionLevel = await select<'restricted' | 'standard' | 'privileged'>({
    message: "Agent permission level:",
    choices: [
      { value: 'restricted', name: "Restricted" },
      { value: 'standard', name: "Standard (recommended)" },
      { value: 'privileged', name: "Privileged" },
    ],
    default: DEFAULT_AGENT_PERMISSION_LEVEL,
  });

  // Semantic memory model selection (downloads/validates best-effort; setup still completes if it fails).
  console.log("\n🧠 Semantic Memory\n");
  console.log("Hi-Boss can store semantic memories locally for agents (vector search).\n");

  const daemonConfig = getDefaultConfig();
  const memoryMode = await select<MemoryModelMode>({
    message: "Choose an embedding model source:",
    choices: [
      { value: "default", name: "Download default model (Qwen3-Embedding-0.6B GGUF)" },
      { value: "local", name: "Use a local GGUF file (absolute path)" },
    ],
  });

  let memory: ResolvedMemoryModelConfig;
  if (memoryMode === "default") {
    console.log("\nDownloading and validating the default embedding model...\n");
    memory = await resolveAndValidateMemoryModel({
      hibossDir: daemonConfig.dataDir,
      mode: "default",
    });
  } else {
    const modelPath = (await input({
      message: "Absolute path to GGUF model file:",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return "Model path is required";
        if (!path.isAbsolute(trimmed)) return "Please provide an absolute path";
        return true;
      },
    })).trim();

    console.log("\nValidating local embedding model...\n");
    memory = await resolveAndValidateMemoryModel({
      hibossDir: daemonConfig.dataDir,
      mode: "local",
      modelPath,
    });
  }

  const sessionDailyResetAt = (await input({
    message: "Session daily reset at (HH:MM) (optional):",
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
  })).trim();

  const sessionIdleTimeout = (await input({
    message: "Session idle timeout (e.g., 2h, 30m) (optional):",
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
  })).trim();

  const sessionMaxTokensRaw = (await input({
    message: "Session max tokens (optional):",
    default: "",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return true;
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return "Session max tokens must be a positive number";
      return true;
    },
  })).trim();

  const sessionMaxTokens = sessionMaxTokensRaw ? Math.trunc(Number(sessionMaxTokensRaw)) : undefined;

  const metadataRaw = (await input({
    message: "Agent metadata JSON (optional):",
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
  })).trim();

  const metadata = metadataRaw ? (JSON.parse(metadataRaw) as Record<string, unknown>) : undefined;

  const sessionPolicy =
    sessionDailyResetAt || sessionIdleTimeout || sessionMaxTokens !== undefined
      ? {
          dailyResetAt: sessionDailyResetAt ? parseDailyResetAt(sessionDailyResetAt).normalized : undefined,
          idleTimeout: sessionIdleTimeout || undefined,
          maxTokens: sessionMaxTokens,
        }
      : undefined;

  // Step 4: Telegram binding (required)
  console.log("\n📱 Telegram Integration\n");
  console.log("\n📋 To create a Telegram bot:");
  console.log("   1. Open Telegram and search for @BotFather");
  console.log("   2. Send /newbot and follow the instructions");
  console.log("   3. Copy the bot token (looks like: 123456789:ABCdef...)\n");

  const adapterToken = await input({
    message: "Enter your Telegram bot token:",
    validate: (value) => {
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(value.trim())) {
        return "Invalid token format. Should look like: 123456789:ABCdef...";
      }
      return true;
    },
  });

  const adapterBossId = await input({
    message: "Your Telegram username (to identify you as the boss):",
    validate: (value) => {
      if (value.trim().length === 0) {
        return "Telegram username is required";
      }
      return true;
    },
  });

  const adapter: SetupConfig["adapter"] = {
    adapterType: "telegram",
    adapterToken: adapterToken.trim(),
    adapterBossId: adapterBossId.trim().replace(/^@/, ""), // Store without @
  };

  // Step 5: Boss token
  console.log("\n🔐 Boss Token\n");
  console.log("The boss token identifies you as the boss for administrative tasks.");
  console.log("Choose something short you'll remember.\n");

  let bossToken: string;
  while (true) {
    bossToken = await password({
      message: "Enter your boss token:",
      validate: (value) => {
        if (value.length < 4) {
          return "Boss token must be at least 4 characters";
        }
        return true;
      },
    });

    const confirmToken = await password({
      message: "Confirm boss token:",
    });

    if (bossToken === confirmToken) {
      break;
    }

    console.error("\n❌ Tokens do not match. Please try again.\n");
  }

  // Execute setup
  console.log("\n⚙️  Applying configuration...\n");

  const config: SetupConfig = {
    provider,
    bossName,
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
    adapter,
    bossToken,
    memory,
  };

  try {
    const agentToken = await executeSetup(config);

    console.log("✅ Setup complete!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`   agent-name:  ${agentName}`);
    console.log(`   agent-token: ${agentToken}`);
    console.log(`   boss-token:  ${bossToken}`);
    console.log(`   memory-enabled: ${memory.enabled ? "true" : "false"}`);
    if (memory.enabled) {
      console.log(`   memory-model-path: ${memory.modelPath}`);
      console.log(`   memory-model-dims: ${memory.dims}`);
    } else if (memory.lastError) {
      console.log(`   memory-last-error: ${memory.lastError}`);
    }
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("\n⚠️  Save these tokens! They won't be shown again.\n");
    console.log("📱 Telegram bot is configured. Start the daemon with:");
    console.log("   hiboss daemon start\n");
  } catch (err) {
    const error = err as Error;
    console.error(`\n❌ Setup failed: ${error.message}\n`);
    process.exit(1);
  }
}

/**
 * Run default setup with pre-configured values.
 */
export async function runDefaultSetup(options: DefaultSetupOptions): Promise<void> {
  console.log("\n⚡ Running default setup...\n");

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
    console.log("\nTo start over: hiboss daemon stop && rm -rf ~/.hiboss && hiboss setup\n");
    return;
  }

  const filePath = path.resolve(process.cwd(), options.config);
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
    hibossDir: daemonConfig.dataDir,
    mode: sel.mode,
    modelPath: sel.modelPath,
  });
  const memory = normalizeMemoryConfig(config);

  try {
    const agentToken = await executeSetup(config);

    console.log("✅ Default setup complete!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
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

/**
 * Main setup entry point.
 */
export async function runSetup(isDefault: true, options: DefaultSetupOptions): Promise<void>;
export async function runSetup(isDefault: false, options?: Record<string, never>): Promise<void>;
export async function runSetup(
  isDefault: boolean,
  options: DefaultSetupOptions | Record<string, never> = {}
): Promise<void> {
  if (isDefault) {
    await runDefaultSetup(options as DefaultSetupOptions);
    return;
  }
  await runInteractiveSetup();
}
