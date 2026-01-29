import * as os from "os";
import * as path from "path";
import { input, select, confirm, password } from "@inquirer/prompts";
import { IpcClient } from "../ipc-client.js";
import { getSocketPath, getDefaultConfig, isDaemonRunning } from "../../daemon/daemon.js";
import { HiBossDatabase } from "../../daemon/db/database.js";
import { setupAgentHome } from "../../agent/home-setup.js";
import type { SetupCheckResult, SetupExecuteResult } from "../../daemon/ipc/types.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../shared/validation.js";
import {
  DEFAULT_SETUP_AGENT_NAME,
  DEFAULT_SETUP_AUTO_LEVEL,
  DEFAULT_SETUP_BIND_TELEGRAM,
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
  bossName?: string;
  bossToken?: string;
  adapterType?: string;
  adapterToken?: string;
  adapterBossId?: string;
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
  };
  adapter?: {
    adapterType: string;
    adapterToken: string;
    adapterBossId?: string;
  };
  bossToken: string;
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
      });

      // Create adapter binding if provided
      if (config.adapter) {
        db.createBinding(config.agent.name, config.adapter.adapterType, config.adapter.adapterToken);

        // Store boss ID for this adapter
        if (config.adapter.adapterBossId) {
          db.setAdapterBossId(config.adapter.adapterType, config.adapter.adapterBossId);
        }
      }

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

  // Step 4: Telegram binding
  console.log("\n📱 Telegram Integration\n");

  const bindTelegram = await confirm({
    message: "Would you like to bind a Telegram bot?",
    default: DEFAULT_SETUP_BIND_TELEGRAM,
  });

  let adapter: SetupConfig['adapter'];
  if (bindTelegram) {
    console.log("\n📋 To create a Telegram bot:");
    console.log("   1. Open Telegram and search for @BotFather");
    console.log("   2. Send /newbot and follow the instructions");
    console.log("   3. Copy the bot token (looks like: 123456789:ABCdef...)\n");

    const adapterToken = await input({
      message: "Enter your Telegram bot token:",
      validate: (value) => {
        if (!/^\d+:[A-Za-z0-9_-]+$/.test(value)) {
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

    adapter = {
      adapterType: 'telegram',
      adapterToken,
      adapterBossId: adapterBossId.replace(/^@/, ''),  // Store without @
    };
  }

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
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("\n⚠️  Save this token! It won't be shown again.\n");

    if (adapter) {
      console.log("📱 Telegram bot is configured. Start the daemon with:");
      console.log("   hiboss daemon start\n");
    }
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

  const providedBossToken = options.bossToken?.trim();
  if (!providedBossToken) {
    console.error("❌ --boss-token is required\n");
    process.exit(1);
  }
  if (providedBossToken.length < 4) {
    console.error("❌ --boss-token must be at least 4 characters\n");
    process.exit(1);
  }

  const bossToken = providedBossToken;

  // Default configuration
  const config: SetupConfig = {
    provider: DEFAULT_SETUP_PROVIDER,
    bossName: options.bossName || getDefaultSetupBossName(),
    agent: {
      name: DEFAULT_SETUP_AGENT_NAME,
      description: getDefaultSetupAgentDescription(DEFAULT_SETUP_AGENT_NAME),
      workspace: getDefaultSetupWorkspace(),
      model: DEFAULT_SETUP_MODEL_BY_PROVIDER.claude,
      reasoningEffort: DEFAULT_SETUP_REASONING_EFFORT,
      autoLevel: DEFAULT_SETUP_AUTO_LEVEL,
    },
    bossToken,
  };

  // Add adapter if specified
  if (options.adapterType === 'telegram' && options.adapterToken) {
    if (!options.adapterBossId) {
      console.error(`❌ --adapter-boss-id is required when using --adapter-type telegram\n`);
      process.exit(1);
    }
    config.adapter = {
      adapterType: 'telegram',
      adapterToken: options.adapterToken,
      adapterBossId: options.adapterBossId.replace(/^@/, ''),
    };
  } else if (options.adapterType && !options.adapterToken) {
    console.error(`❌ --adapter-token is required when using --adapter-type ${options.adapterType}\n`);
    process.exit(1);
  }

  try {
    const agentToken = await executeSetup(config);

    console.log("✅ Default setup complete!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`   boss-name:   ${config.bossName}`);
    console.log(`   agent-name:  ${DEFAULT_SETUP_AGENT_NAME}`);
    console.log(`   agent-token: ${agentToken}`);
    console.log(`   boss-token:  ${bossToken}`);
    console.log(`   provider:    ${DEFAULT_SETUP_PROVIDER}`);
    console.log(`   model:       ${DEFAULT_SETUP_MODEL_BY_PROVIDER.claude}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("\n⚠️  Save the agent token and boss token! They won't be shown again.\n");

    if (config.adapter) {
      console.log("📱 Telegram bot is configured. Start the daemon with:");
      console.log("   hiboss daemon start\n");
    } else {
      console.log("💡 No adapter was bound. You can bind one later with:");
      console.log(
        `   hiboss agent bind --name ${DEFAULT_SETUP_AGENT_NAME} --adapter-type telegram --adapter-token <TOKEN>\n`
      );
    }
  } catch (err) {
    const error = err as Error;
    console.error(`\n❌ Setup failed: ${error.message}\n`);
    process.exit(1);
  }
}

/**
 * Main setup entry point.
 */
export async function runSetup(isDefault: boolean, options: DefaultSetupOptions): Promise<void> {
  if (isDefault) {
    await runDefaultSetup(options);
  } else {
    await runInteractiveSetup();
  }
}
