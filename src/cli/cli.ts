import { Command } from "commander";
import {
  startDaemon,
  stopDaemon,
  daemonStatus,
  sendEnvelope,
  listEnvelopes,
  getEnvelope,
  registerAgent,
  listAgents,
  setAgentSessionPolicy,
  bindAgent,
  unbindAgent,
  setAgentPermissionLevel,
  getAgentPermissionLevel,
  runBackground,
  runSetup,
  getPermissionPolicy,
  setPermissionPolicy,
} from "./commands/index.js";
import { DEFAULT_ENVELOPE_LIST_BOX } from "../shared/defaults.js";

const program = new Command();

program
  .name("hiboss")
  .description("Hi-Boss: Agent-to-agent and agent-to-human communication daemon")
  .version("1.0.0");

// Daemon commands
const daemon = program.command("daemon").description("Daemon management");

daemon
  .command("start")
  .description("Start the daemon")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .option("--debug", "Enable debug logging for messages and envelopes")
  .action((options) => {
    startDaemon({ token: options.token, debug: options.debug });
  });

daemon
  .command("stop")
  .description("Stop the daemon")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    stopDaemon({ token: options.token });
  });

daemon
  .command("status")
  .description("Show daemon status")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    daemonStatus({ token: options.token });
  });

// Envelope commands
const envelope = program.command("envelope").description("Envelope operations");

envelope
  .command("send")
  .description("Send an envelope")
  .requiredOption(
    "--to <address>",
    "Destination address (agent:<name> or channel:<adapter>:<chat-id>)"
  )
  .option("--from <address>", "Sender address (boss token only)")
  .option("--from-boss", "Mark sender as boss (boss token only)")
  .option("--from-name <name>", "Semantic sender name for display (boss token only)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .option("--text <text>", "Envelope text (use - to read from stdin)")
  .option("--text-file <path>", "Read envelope text from file")
  .option("--attachment <path>", "Attachment path (can be used multiple times)", collect, [])
  .option(
    "--deliver-at <time>",
    "Schedule delivery time (ISO 8601 or relative: +2h, +30m, +1Y2M, -15m; units: Y/M/D/h/m/s)"
  )
  .action((options) => {
    sendEnvelope({
      from: options.from,
      fromBoss: options.fromBoss,
      fromName: options.fromName,
      to: options.to,
      token: options.token,
      text: options.text,
      textFile: options.textFile,
      attachment: options.attachment,
      deliverAt: options.deliverAt,
    });
  });

envelope
  .command("list")
  .description("List envelopes")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .option("--address <address>", "List envelopes for an address (boss token only)")
  .option("--box <box>", "inbox or outbox", DEFAULT_ENVELOPE_LIST_BOX)
  .option("--status <status>", "pending or done")
  .option("-n, --limit <n>", "Maximum number of results", parseInt)
  .option("--n <count>", "Deprecated: use --limit", parseInt)
  .option("--as-turn", "Format output as a turn preview (pending inbox only)")
  .action((options) => {
    listEnvelopes({
      token: options.token,
      address: options.address,
      box: options.box as "inbox" | "outbox",
      status: options.status as "pending" | "done" | undefined,
      limit: options.limit ?? options.n,
      asTurn: options.asTurn,
    });
  });

envelope
  .command("get")
  .description("Get an envelope by ID")
  .requiredOption("--id <id>", "Envelope ID")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    getEnvelope({
      id: options.id,
      token: options.token,
    });
  });

// Agent commands
const agent = program.command("agent").description("Agent management");

agent
  .command("register")
  .description("Register a new agent")
  .requiredOption("--name <name>", "Agent name (alphanumeric with hyphens)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .option("--description <description>", "Agent description")
  .option("--workspace <path>", "Workspace path for unified-agent-sdk")
  .option(
    "--session-daily-reset-at <time>",
    "Daily session reset time in local timezone (HH:MM)"
  )
  .option(
    "--session-idle-timeout <duration>",
    "Refresh session after being idle longer than this duration (e.g., 2h, 30m; units: d/h/m/s)"
  )
  .option(
    "--session-max-tokens <n>",
    "Refresh session after a run uses more than N tokens",
    parseInt
  )
  .action((options) => {
    registerAgent({
      token: options.token,
      name: options.name,
      description: options.description,
      workspace: options.workspace,
      sessionDailyResetAt: options.sessionDailyResetAt,
      sessionIdleTimeout: options.sessionIdleTimeout,
      sessionMaxTokens: options.sessionMaxTokens,
    });
  });

agent
  .command("list")
  .description("List all agents")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    listAgents({ token: options.token });
  });

agent
  .command("bind")
  .description("Bind an adapter (e.g., Telegram bot) to an agent")
  .requiredOption("--name <name>", "Agent name")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .requiredOption("--adapter-type <type>", "Adapter type (e.g., telegram)")
  .requiredOption("--adapter-token <token>", "Adapter token (e.g., Telegram bot token)")
  .action((options) => {
    bindAgent({
      token: options.token,
      name: options.name,
      adapterType: options.adapterType,
      adapterToken: options.adapterToken,
    });
  });

agent
  .command("unbind")
  .description("Unbind an adapter from an agent")
  .requiredOption("--name <name>", "Agent name")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .requiredOption("--adapter-type <type>", "Adapter type (e.g., telegram)")
  .action((options) => {
    unbindAgent({
      token: options.token,
      name: options.name,
      adapterType: options.adapterType,
    });
  });

agent
  .command("session-policy")
  .description("Set session refresh policy for an agent")
  .requiredOption("--name <name>", "Agent name")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .option(
    "--session-daily-reset-at <time>",
    "Daily session reset time in local timezone (HH:MM)"
  )
  .option(
    "--session-idle-timeout <duration>",
    "Refresh session after being idle longer than this duration (e.g., 2h, 30m; units: d/h/m/s)"
  )
  .option(
    "--session-max-tokens <n>",
    "Refresh session after a run uses more than N tokens",
    parseInt
  )
  .option("--clear", "Clear session policy")
  .action((options) => {
    setAgentSessionPolicy({
      token: options.token,
      name: options.name,
      sessionDailyResetAt: options.sessionDailyResetAt,
      sessionIdleTimeout: options.sessionIdleTimeout,
      sessionMaxTokens: options.sessionMaxTokens,
      clear: options.clear,
    });
  });

agent
  .command("background")
  .description("Run a non-interactive background task as this agent")
  .requiredOption("--token <token>", "Agent token")
  .requiredOption("--task <text>", "Task text")
  .action((options) => {
    return runBackground({
      token: options.token,
      task: options.task,
    });
  });

const agentPermission = agent
  .command("permission")
  .description("Agent permission management");

agentPermission
  .command("get")
  .description("Get an agent permission level")
  .requiredOption("--name <name>", "Agent name")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    getAgentPermissionLevel({
      token: options.token,
      name: options.name,
    });
  });

agentPermission
  .command("set")
  .description("Set an agent permission level")
  .requiredOption("--name <name>", "Agent name")
  .requiredOption(
    "--permission-level <level>",
    "Permission level (restricted, standard, privileged)"
  )
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    setAgentPermissionLevel({
      token: options.token,
      name: options.name,
      permissionLevel: options.permissionLevel,
    });
  });

// Setup command
const setup = program.command("setup").description("Initial system configuration");

setup
  .command("interactive", { isDefault: true })
  .description("Run interactive setup wizard (default)")
  .action(() => {
    runSetup(false, {});
  });

setup
  .command("default")
  .description("Run setup with default values")
  .option("--boss-name <name>", "Your name (how the agent should address you)")
  .requiredOption("--boss-token <token>", "Boss token for administrative tasks")
  .option("--adapter-type <type>", "Adapter type to bind (e.g., telegram)")
  .option("--adapter-token <token>", "Adapter bot token")
  .option("--adapter-boss-id <id>", "Your ID on the adapter (e.g., Telegram username)")
  .action((options) => {
    runSetup(true, {
      bossName: options.bossName,
      bossToken: options.bossToken,
      adapterType: options.adapterType,
      adapterToken: options.adapterToken,
      adapterBossId: options.adapterBossId,
    });
  });

// Permission commands
const permission = program.command("permission").description("Permission management");
const policy = permission.command("policy").description("Permission policy management");

policy
  .command("get")
  .description("Get permission policy")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    getPermissionPolicy({ token: options.token });
  });

policy
  .command("set")
  .description("Set permission policy from a JSON file")
  .requiredOption("--file <path>", "Path to permission policy JSON file")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    setPermissionPolicy({ token: options.token, file: options.file });
  });

// Helper to collect multiple values for an option
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export { program };
