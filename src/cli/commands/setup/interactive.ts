import * as path from "path";
import { input, password } from "@inquirer/prompts";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../../shared/validation.js";
import {
  DEFAULT_SETUP_AGENT_NAME,
  DEFAULT_SETUP_PERMISSION_LEVEL,
  getDefaultAgentDescription,
  getDefaultSetupBossName,
  getDefaultSetupWorkspace,
} from "../../../shared/defaults.js";
import { getDaemonIanaTimeZone, isValidIanaTimeZone } from "../../../shared/timezone.js";
import { checkSetupStatus, executeSetup } from "./core.js";
import type { SetupConfig } from "./types.js";
import {
  promptAgentAdvancedOptions,
  promptAgentModel,
  promptAgentPermissionLevel,
  promptAgentProvider,
  promptAgentReasoningEffort,
} from "./agent-options-prompts.js";

export async function runInteractiveSetup(): Promise<void> {
  console.log("\n🚀 Hi-Boss Setup Wizard\n");
  console.log("This wizard will help you configure Hi-Boss.\n");

  let setupStatus: Awaited<ReturnType<typeof checkSetupStatus>>;
  try {
    setupStatus = await checkSetupStatus();
  } catch (err) {
    console.error(`\n❌ Setup check failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  if (setupStatus.ready && setupStatus.hasSettingsFile) {
    console.log("✅ Setup is already complete!");
    console.log("\nTo start over: hiboss daemon stop && rm -rf ~/hiboss && hiboss setup\n");
    console.log("(Advanced: override the Hi-Boss dir with HIBOSS_DIR.)\n");
    return;
  }

  if (!setupStatus.hasSettingsFile && (setupStatus.completed || setupStatus.agents.length > 0)) {
    console.log("⚠️ settings.json is missing; entering recovery setup to regenerate canonical config.\n");
  }
  const hibossDirForDisplay = (process.env.HIBOSS_DIR ?? "").trim() || "~/hiboss";

  const hasPersistedState =
    setupStatus.hasSettingsFile &&
    (setupStatus.completed ||
      setupStatus.agents.length > 0 ||
      Object.values(setupStatus.userInfo.missing).some((v) => !v));

  if (hasPersistedState) {
    console.error("\n❌ Interactive setup only supports first-time bootstrap on a clean state.\n");
    console.error(`Edit ${hibossDirForDisplay}/settings.json directly, then restart the daemon.\n`);
    process.exit(1);
  }

  const daemonTimeZone = getDaemonIanaTimeZone();

  console.log("\n👤 User Information\n");

  const bossName = (
    await input({
      message: "Your name (how the agent should address you):",
      default: getDefaultSetupBossName(),
      validate: (value) => (value.trim().length === 0 ? "Boss name cannot be empty" : true),
    })
  ).trim();

  console.log(`\n🕒 Detected daemon timezone: ${daemonTimeZone}\n`);
  const bossTimezone = (
    await input({
      message: "Boss timezone (IANA) (used for all displayed timestamps):",
      default: daemonTimeZone,
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return "Boss timezone is required";
        if (!isValidIanaTimeZone(trimmed)) {
          return "Invalid timezone (expected IANA name like Asia/Shanghai, America/Los_Angeles, UTC)";
        }
        return true;
      },
    })
  ).trim();

  const adapterBossIdsRaw = (
    await input({
      message: "Boss Telegram usernames (comma-separated, e.g. ethanlee,alice):",
      validate: (value) => (value.trim().length === 0 ? "At least one Telegram username is required" : true),
    })
  ).trim();
  const adapterBossIds = adapterBossIdsRaw
    .split(",")
    .map((value) => value.trim().replace(/^@/, ""))
    .filter((value) => value.length > 0);
  if (adapterBossIds.length < 1) {
    console.error("\n❌ At least one Telegram username is required.\n");
    process.exit(1);
  }
  const uniqueBossIds = new Set<string>();
  for (const bossId of adapterBossIds) {
    const key = bossId.toLowerCase();
    if (uniqueBossIds.has(key)) {
      console.error(`\n❌ Duplicate Telegram username: ${bossId}\n`);
      process.exit(1);
    }
    uniqueBossIds.add(key);
  }

  console.log("\n🔐 Admin Token\n");
  console.log("The admin token identifies you for administrative tasks.");
  console.log("Choose something strong you'll remember.\n");

  let adminToken: string;
  while (true) {
    const enteredAdminToken = await password({
      message: "Enter your admin token:",
      validate: (value) =>
        value.trim().length < 16
          ? "Admin token must be at least 16 characters (excluding leading/trailing whitespace)"
          : true,
    });
    const normalizedAdminToken = enteredAdminToken.trim();

    const confirmToken = (await password({ message: "Confirm admin token:" })).trim();
    if (normalizedAdminToken === confirmToken) {
      adminToken = normalizedAdminToken;
      break;
    }
    console.error("\n❌ Tokens do not match. Please try again.\n");
  }

  console.log("\n📦 Primary Agent Information\n");

  const primaryAgentName = (
    await input({
      message: "Primary agent name (slug):",
      default: DEFAULT_SETUP_AGENT_NAME,
      validate: (value) => (isValidAgentName(value.trim()) ? true : AGENT_NAME_ERROR_MESSAGE),
    })
  ).trim();

  const primaryWorkspace = await input({
    message: "Primary agent workspace directory:",
    default: getDefaultSetupWorkspace(),
    validate: (value) => (path.isAbsolute(value) ? true : "Please provide an absolute path"),
  });

  const primaryPermissionLevel = await promptAgentPermissionLevel({
    message: "Primary agent permission level:",
    defaultValue: DEFAULT_SETUP_PERMISSION_LEVEL,
  });

  const primaryProvider = await promptAgentProvider("Primary agent provider:");

  const primaryModel = await promptAgentModel({
    provider: primaryProvider,
    message: "Primary agent model:",
  });

  const primaryReasoningEffort = await promptAgentReasoningEffort("Primary agent reasoning effort:");

  const primaryAgentDescription = (
    await input({
      message: "Primary agent description (optional):",
      default: getDefaultAgentDescription(primaryAgentName),
    })
  ).trim();

  const primaryAdvanced = await promptAgentAdvancedOptions({
    agentLabel: "Primary agent",
    provider: primaryProvider,
  });

  console.log("\n📱 Telegram Binding\n");
  console.log("\n📋 To create a Telegram bot:");
  console.log("   1. Open Telegram and search for @BotFather");
  console.log("   2. Send /newbot and follow the instructions");
  console.log("   3. Copy the bot token (looks like: 123456789:ABCdef...)\n");

  const adapterToken = (
    await input({
      message: "Enter your Telegram bot token:",
      validate: (value) =>
        /^\d+:[A-Za-z0-9_-]+$/.test(value.trim())
          ? true
          : "Invalid token format. Should look like: 123456789:ABCdef...",
    })
  ).trim();

  console.log("\n🧰 Secondary Agent Information\n");

  const secondaryAgentName = (
    await input({
      message: "Secondary agent name (slug):",
      default: "walt",
      validate: (value) => {
        const name = value.trim();
        if (!isValidAgentName(name)) return AGENT_NAME_ERROR_MESSAGE;
        if (name.toLowerCase() === primaryAgentName.toLowerCase()) {
          return "Secondary name must be different from primary name";
        }
        return true;
      },
    })
  ).trim();

  const secondaryWorkspace = await input({
    message: "Secondary agent workspace directory:",
    default: primaryWorkspace,
    validate: (value) => (path.isAbsolute(value) ? true : "Please provide an absolute path"),
  });

  const secondaryPermissionLevel = await promptAgentPermissionLevel({
    message: "Secondary agent permission level:",
    defaultValue: primaryPermissionLevel,
  });

  const secondaryProvider = await promptAgentProvider("Secondary agent provider:");

  const secondaryModel = await promptAgentModel({
    provider: secondaryProvider,
    message: "Secondary agent model:",
  });

  const secondaryReasoningEffort = await promptAgentReasoningEffort("Secondary agent reasoning effort:");

  const secondaryAgentDescription = (
    await input({
      message: "Secondary agent description (optional):",
      default: getDefaultAgentDescription(secondaryAgentName),
    })
  ).trim();

  const secondaryAdvanced = await promptAgentAdvancedOptions({
    agentLabel: "Secondary agent",
    provider: secondaryProvider,
  });

  console.log("\n⚙️  Applying configuration...\n");

  const config: SetupConfig = {
    bossName,
    bossTimezone,
    primaryAgent: {
      name: primaryAgentName,
      provider: primaryProvider,
      description: primaryAgentDescription,
      workspace: primaryWorkspace,
      model: primaryModel,
      reasoningEffort: primaryReasoningEffort,
      permissionLevel: primaryPermissionLevel,
      sessionPolicy: primaryAdvanced.sessionPolicy,
      metadata: primaryAdvanced.metadata,
    },
    secondaryAgent: {
      name: secondaryAgentName,
      provider: secondaryProvider,
      description: secondaryAgentDescription,
      workspace: secondaryWorkspace,
      model: secondaryModel,
      reasoningEffort: secondaryReasoningEffort,
      permissionLevel: secondaryPermissionLevel,
      sessionPolicy: secondaryAdvanced.sessionPolicy,
      metadata: secondaryAdvanced.metadata,
    },
    adapter: {
      adapterType: "telegram",
      adapterToken,
      adapterBossIds,
    },
    adminToken,
  };

  try {
    const setupResult = await executeSetup(config);

    console.log("✅ Setup complete!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`   daemon-timezone: ${daemonTimeZone}`);
    console.log(`   boss-timezone:  ${bossTimezone}`);
    console.log(`   primary-agent-name:   ${primaryAgentName}`);
    console.log(`   primary-agent-token:  ${setupResult.primaryAgentToken}`);
    console.log(`   secondary-agent-name: ${secondaryAgentName}`);
    console.log(`   secondary-agent-token:${setupResult.secondaryAgentToken}`);
    for (const item of setupResult.userTokens) {
      const principalLabel = /^[0-9]+$/.test(item.principal) ? item.principal : `@${item.principal}`;
      console.log(`   user-token[${principalLabel}]: ${item.token}`);
    }
    console.log(`   admin-token: ${adminToken}`);
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
