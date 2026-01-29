import * as fs from "fs";
import * as path from "path";
import { input, select, password } from "@inquirer/prompts";
import { IpcClient } from "../ipc-client.js";
import { getSocketPath, getDefaultConfig, isDaemonRunning } from "../../daemon/daemon.js";
import { HiBossDatabase } from "../../daemon/db/database.js";
import { setupAgentHome } from "../../agent/home-setup.js";
import type { SetupCheckResult, SetupExecuteResult } from "../../daemon/ipc/types.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../shared/validation.js";
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
    model?: string;
    reasoningEffort: 'low' | 'medium' | 'high';
    autoLevel: 'low' | 'medium' | 'high';
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
}

interface SetupConfigFileV1 {
  version: 1;
  "boss-name"?: string;
  "boss-token": string;
  provider?: "claude" | "codex";
  agent: {
    name?: string;
    description?: string;
    workspace?: string;
    model?: string;
    "reasoning-effort"?: "low" | "medium" | "high";
    "auto-level"?: "low" | "medium" | "high";
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
  const model =
    typeof modelRaw === "string" && modelRaw.trim()
      ? modelRaw.trim()
      : DEFAULT_SETUP_MODEL_BY_PROVIDER[provider];

  const reasoningEffortRaw = agentRaw["reasoning-effort"];
  const reasoningEffort =
    reasoningEffortRaw === "low" || reasoningEffortRaw === "medium" || reasoningEffortRaw === "high"
      ? reasoningEffortRaw
      : DEFAULT_SETUP_REASONING_EFFORT;

  const autoLevelRaw = agentRaw["auto-level"];
  const autoLevel =
    autoLevelRaw === "low" || autoLevelRaw === "medium" || autoLevelRaw === "high"
      ? autoLevelRaw
      : DEFAULT_SETUP_AUTO_LEVEL;

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

  return config;
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
  // Try IPC first (daemon running)
  try {
    const client = new IpcClient(getSocketPath());
    const result = await client.call<SetupExecuteResult>("setup.execute", {
      provider: config.provider,
      bossName: config.bossName,
      agent: config.agent,
      bossToken: config.bossToken,
      adapter: config.adapter,
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

    const result = db.runInTransaction(() => {
      // Set boss name
      db.setBossName(config.bossName);

      // Set default provider
      db.setDefaultProvider(config.provider);

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
  let model: string;
  if (provider === 'claude') {
    model = await select({
      message: "Select model:",
      choices: SETUP_MODEL_CHOICES_BY_PROVIDER.claude.map((value) => ({
        value,
        name:
          value === "opus"
            ? "Opus (most capable)"
            : value === "sonnet"
              ? "Sonnet (balanced)"
              : "Haiku (fastest)",
      })),
    });
  } else {
    model = await select({
      message: "Select model:",
      choices: SETUP_MODEL_CHOICES_BY_PROVIDER.codex.map((value) => ({
        value,
        name: value === "gpt-5.2" ? "GPT-5.2" : "GPT-5.2 Codex",
      })),
    });
  }

  const reasoningEffort = await select<'low' | 'medium' | 'high'>({
    message: "Reasoning effort:",
    choices: [
      { value: 'low', name: "Low - Quick responses" },
      { value: 'medium', name: "Medium - Balanced (recommended)" },
      { value: 'high', name: "High - Thorough analysis" },
    ],
    default: DEFAULT_SETUP_REASONING_EFFORT,
  });

  console.log("\n📊 Auto-approval level determines how much the agent can do without asking:");
  console.log("   • Low: Confirm most actions, safer for sensitive work");
  console.log("   • Medium: Auto-approve common operations");
  console.log("   • High: Maximum autonomy, minimal interruptions\n");

  const autoLevel = await select<'low' | 'medium' | 'high'>({
    message: "Auto-approval level:",
    choices: [
      { value: 'low', name: "Low - Confirm most actions" },
      { value: 'medium', name: "Medium - Balanced" },
      { value: 'high', name: "High - Maximum autonomy (recommended)" },
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

  const bossToken = await password({
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

  if (bossToken !== confirmToken) {
    console.error("\n❌ Tokens do not match. Please run setup again.\n");
    process.exit(1);
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
  };

  try {
    const agentToken = await executeSetup(config);

    console.log("✅ Setup complete!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`   agent-name:  ${agentName}`);
    console.log(`   agent-token: ${agentToken}`);
    console.log(`   boss-token:  ${bossToken}`);
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

  try {
    const agentToken = await executeSetup(config);

    console.log("✅ Default setup complete!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`   boss-name:   ${config.bossName}`);
    console.log(`   agent-name:  ${config.agent.name}`);
    console.log(`   agent-token: ${agentToken}`);
    console.log(`   boss-token:  ${config.bossToken}`);
    console.log(`   provider:    ${config.provider}`);
    console.log(`   model:       ${config.agent.model ?? DEFAULT_SETUP_MODEL_BY_PROVIDER[config.provider]}`);
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
