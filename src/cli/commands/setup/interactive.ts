import * as path from "path";
import { input, select, password } from "@inquirer/prompts";
import { getDefaultConfig } from "../../../daemon/daemon.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../../shared/validation.js";
import { parseDailyResetAt, parseDurationToMs } from "../../../shared/session-policy.js";
import {
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_SETUP_AGENT_NAME,
  DEFAULT_SETUP_AUTO_LEVEL,
  DEFAULT_SETUP_MODEL_BY_PROVIDER,
  DEFAULT_SETUP_REASONING_EFFORT,
  SETUP_MODEL_CHOICES_BY_PROVIDER,
  getDefaultSetupAgentDescription,
  getDefaultSetupBossName,
  getDefaultSetupWorkspace,
} from "../../../shared/defaults.js";
import { resolveAndValidateMemoryModel, type MemoryModelMode, type ResolvedMemoryModelConfig } from "../../memory-model.js";
import { checkSetupStatus, executeSetup } from "./core.js";
import type { SetupConfig } from "./types.js";
import { isPlainObject } from "./utils.js";

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
  const provider = await select<"claude" | "codex">({
    message: "Choose your default AI provider:",
    choices: [
      { value: "claude", name: "Claude Code (Anthropic)" },
      { value: "codex", name: "Codex (OpenAI)" },
    ],
  });

  const PROVIDER_SOURCE_HOME_CUSTOM = "__custom__";
  const defaultProviderHome = provider === "codex" ? "~/.codex" : "~/.claude";
  const providerSourceHomeChoice = await select<string>({
    message: "Choose provider source home (where to import settings/auth from):",
    choices: [
      {
        value: defaultProviderHome,
        name: `${defaultProviderHome} (recommended)`,
      },
      { value: PROVIDER_SOURCE_HOME_CUSTOM, name: "Custom path..." },
    ],
  });

  const providerSourceHome =
    providerSourceHomeChoice === PROVIDER_SOURCE_HOME_CUSTOM
      ? (
          await input({
            message: "Provider source home (absolute path or starting with ~):",
            validate: (value) => {
              const trimmed = value.trim();
              if (!trimmed) return "Provider source home is required";
              if (!path.isAbsolute(trimmed) && !trimmed.startsWith("~")) {
                return "Please provide an absolute path or one starting with ~";
              }
              return true;
            },
          })
        ).trim()
      : providerSourceHomeChoice;

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

  const agentName = (
    await input({
      message: "Agent name (slug):",
      default: DEFAULT_SETUP_AGENT_NAME,
      validate: (value) => {
        const name = value.trim();
        if (!isValidAgentName(name)) {
          return AGENT_NAME_ERROR_MESSAGE;
        }
        return true;
      },
    })
  ).trim();

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
      { value: "none", name: "None - No reasoning (fastest)" },
      { value: "low", name: "Low - Quick responses" },
      { value: "medium", name: "Medium - Balanced (recommended)" },
      { value: "high", name: "High - Thorough analysis" },
      { value: "xhigh", name: "XHigh - Extra thorough (slowest)" },
    ],
    default: DEFAULT_SETUP_REASONING_EFFORT,
  });
  const reasoningEffort: SetupConfig["agent"]["reasoningEffort"] =
    reasoningEffortChoice === "default" ? null : reasoningEffortChoice;

  console.log("\n📊 Auto-level controls the agent sandbox:");
  console.log("   • Medium: Workspace-scoped (can write workspace + additional dirs; runs many commands)");
  console.log("   • High: Full computer access (can run almost anything)\n");

  const autoLevel = await select<"medium" | "high">({
    message: "Auto-level:",
    choices: [
      { value: "high", name: "High - Full access (recommended)" },
      { value: "medium", name: "Medium - Workspace-scoped" },
    ],
    default: DEFAULT_SETUP_AUTO_LEVEL,
  });

  const permissionLevel = await select<"restricted" | "standard" | "privileged">({
    message: "Agent permission level:",
    choices: [
      { value: "restricted", name: "Restricted" },
      { value: "standard", name: "Standard (recommended)" },
      { value: "privileged", name: "Privileged" },
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
    const modelPath = (
      await input({
        message: "Absolute path to GGUF model file:",
        validate: (value) => {
          const trimmed = value.trim();
          if (!trimmed) return "Model path is required";
          if (!path.isAbsolute(trimmed)) return "Please provide an absolute path";
          return true;
        },
      })
    ).trim();

    console.log("\nValidating local embedding model...\n");
    memory = await resolveAndValidateMemoryModel({
      hibossDir: daemonConfig.dataDir,
      mode: "local",
      modelPath,
    });
  }

  const sessionDailyResetAt = (
    await input({
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
    })
  ).trim();

  const sessionIdleTimeout = (
    await input({
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
    })
  ).trim();

  const sessionMaxContextLengthRaw = (
    await input({
      message: "Session max context length (optional):",
      default: "",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return true;
        const n = Number(trimmed);
        if (!Number.isFinite(n) || n <= 0) return "Session max context length must be a positive number";
        return true;
      },
    })
  ).trim();

  const sessionMaxContextLength = sessionMaxContextLengthRaw
    ? Math.trunc(Number(sessionMaxContextLengthRaw))
    : undefined;

  const metadataRaw = (
    await input({
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
    providerSourceHome,
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

