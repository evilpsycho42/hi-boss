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

  console.log("\n🔐 Boss Token\n");
  console.log("The boss token identifies you as the boss for administrative tasks.");
  console.log("Choose something short you'll remember.\n");

  let bossToken: string;
  while (true) {
    bossToken = await password({
      message: "Enter your boss token:",
      validate: (value) => (value.length < 4 ? "Boss token must be at least 4 characters" : true),
    });

    const confirmToken = await password({ message: "Confirm boss token:" });
    if (bossToken === confirmToken) break;
    console.error("\n❌ Tokens do not match. Please try again.\n");
  }

  console.log("\n📦 Speaker Information (channel-facing)\n");

  const speakerAgentName = (
    await input({
      message: "Speaker agent name (slug):",
      default: DEFAULT_SETUP_AGENT_NAME,
      validate: (value) => (isValidAgentName(value.trim()) ? true : AGENT_NAME_ERROR_MESSAGE),
    })
  ).trim();

  const speakerWorkspace = await input({
    message: "Speaker workspace directory:",
    default: getDefaultSetupWorkspace(),
    validate: (value) => (path.isAbsolute(value) ? true : "Please provide an absolute path"),
  });

  const speakerPermissionLevel = await promptAgentPermissionLevel({
    message: "Speaker permission level:",
    defaultValue: DEFAULT_SETUP_PERMISSION_LEVEL,
  });

  const speakerProvider = await promptAgentProvider("Speaker provider:");

  const speakerModel = await promptAgentModel({
    provider: speakerProvider,
    message: "Speaker model:",
  });

  const speakerReasoningEffort = await promptAgentReasoningEffort("Speaker reasoning effort:");

  const speakerAgentDescription = (
    await input({
      message: "Speaker description (optional):",
      default: getDefaultAgentDescription(speakerAgentName),
    })
  ).trim();

  const speakerAdvanced = await promptAgentAdvancedOptions({ agentLabel: "Speaker" });

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

  console.log("\n🧭 Leader Information (delegation/orchestration)\n");

  const leaderAgentName = (
    await input({
      message: "Leader agent name (slug):",
      default: "kai",
      validate: (value) => {
        const name = value.trim();
        if (!isValidAgentName(name)) return AGENT_NAME_ERROR_MESSAGE;
        if (name.toLowerCase() === speakerAgentName.toLowerCase()) {
          return "Leader name must be different from speaker name";
        }
        return true;
      },
    })
  ).trim();

  const leaderWorkspace = await input({
    message: "Leader workspace directory:",
    default: speakerWorkspace,
    validate: (value) => (path.isAbsolute(value) ? true : "Please provide an absolute path"),
  });

  const leaderPermissionLevel = await promptAgentPermissionLevel({
    message: "Leader permission level:",
    defaultValue: speakerPermissionLevel,
  });

  const leaderProvider = await promptAgentProvider("Leader provider:");

  const leaderModel = await promptAgentModel({
    provider: leaderProvider,
    message: "Leader model:",
  });

  const leaderReasoningEffort = await promptAgentReasoningEffort("Leader reasoning effort:");

  const leaderAgentDescription = (
    await input({
      message: "Leader description (optional):",
      default: getDefaultAgentDescription(leaderAgentName),
    })
  ).trim();

  const leaderAdvanced = await promptAgentAdvancedOptions({ agentLabel: "Leader" });

  console.log("\n⚙️  Applying configuration...\n");

  const config: SetupConfig = {
    bossName,
    bossTimezone,
    speakerAgent: {
      name: speakerAgentName,
      provider: speakerProvider,
      description: speakerAgentDescription,
      workspace: speakerWorkspace,
      model: speakerModel,
      reasoningEffort: speakerReasoningEffort,
      permissionLevel: speakerPermissionLevel,
      sessionPolicy: speakerAdvanced.sessionPolicy,
      metadata: speakerAdvanced.metadata,
    },
    leaderAgent: {
      name: leaderAgentName,
      provider: leaderProvider,
      description: leaderAgentDescription,
      workspace: leaderWorkspace,
      model: leaderModel,
      reasoningEffort: leaderReasoningEffort,
      permissionLevel: leaderPermissionLevel,
      sessionPolicy: leaderAdvanced.sessionPolicy,
      metadata: leaderAdvanced.metadata,
    },
    adapter: {
      adapterType: "telegram",
      adapterToken,
      adapterBossIds,
    },
    bossToken,
  };

  try {
    const setupResult = await executeSetup(config);

    console.log("✅ Setup complete!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`   daemon-timezone: ${daemonTimeZone}`);
    console.log(`   boss-timezone:  ${bossTimezone}`);
    console.log(`   speaker-agent-name:  ${speakerAgentName}`);
    console.log(`   speaker-agent-token: ${setupResult.speakerAgentToken}`);
    console.log(`   leader-agent-name:   ${leaderAgentName}`);
    console.log(`   leader-agent-token:  ${setupResult.leaderAgentToken}`);
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
