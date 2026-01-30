import { Command } from "commander";
import {
  startDaemon,
  stopDaemon,
  daemonStatus,
  sendEnvelope,
  listEnvelopes,
  getEnvelope,
  setReaction,
  registerAgent,
  setAgent,
  listAgents,
  runBackground,
  runSetup,
  memoryAdd,
  memorySearch,
  memoryList,
  memoryCategories,
  memoryGet,
  memoryDelete,
  memoryDeleteCategory,
  memoryClear,
  memorySetup,
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
  .option("--parse-mode <mode>", "Telegram parse mode: plain, markdownv2, html")
  .option("--reply-to <message-id>", "Reply to a channel message by platform message id")
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
      parseMode: options.parseMode,
      replyTo: options.replyTo,
    });
  });

// Reaction commands
const reaction = program.command("reaction").description("Message reactions");

reaction
  .command("set")
  .description("Set a reaction on a channel message")
  .requiredOption("--to <address>", "Target channel address (channel:<adapter>:<chat-id>)")
  .option("--channel-message-id <id>", "Target channel message id on the platform")
  .option("--message-id <id>", "Deprecated: use --channel-message-id")
  .requiredOption("--emoji <emoji>", "Reaction emoji (e.g., 👍)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    if (options.channelMessageId && options.messageId) {
      console.error("error: Cannot use both --channel-message-id and --message-id");
      process.exit(1);
    }
    const messageId = options.channelMessageId ?? options.messageId;
    if (!messageId) {
      console.error("error: --channel-message-id is required");
      process.exit(1);
    }
    setReaction({
      token: options.token,
      to: options.to,
      messageId,
      emoji: options.emoji,
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

// Memory commands
const memory = program.command("memory").description("Semantic memory operations");

memory
  .command("add")
  .description("Add a memory")
  .requiredOption("--text <text>", "Memory text")
  .option("--category <category>", "Memory category")
  .option("--agent-name <name>", "Target agent name (boss token only)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    memoryAdd({
      token: options.token,
      agentName: options.agentName,
      text: options.text,
      category: options.category,
    });
  });

memory
  .command("search")
  .description("Search memories by semantic similarity")
  .requiredOption("--query <query>", "Search query")
  .option("--category <category>", "Filter by category")
  .option("-n, --limit <n>", "Maximum number of results", parseInt)
  .option("--agent-name <name>", "Target agent name (boss token only)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    memorySearch({
      token: options.token,
      agentName: options.agentName,
      query: options.query,
      category: options.category,
      limit: options.limit,
    });
  });

memory
  .command("list")
  .description("List stored memories")
  .option("--category <category>", "Filter by category")
  .option("-n, --limit <n>", "Maximum number of results", parseInt)
  .option("--agent-name <name>", "Target agent name (boss token only)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    memoryList({
      token: options.token,
      agentName: options.agentName,
      category: options.category,
      limit: options.limit,
    });
  });

memory
  .command("categories")
  .description("List known memory categories")
  .option("--agent-name <name>", "Target agent name (boss token only)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    memoryCategories({
      token: options.token,
      agentName: options.agentName,
    });
  });

memory
  .command("get")
  .description("Get a memory by ID")
  .requiredOption("--id <id>", "Memory ID")
  .option("--agent-name <name>", "Target agent name (boss token only)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    memoryGet({
      token: options.token,
      agentName: options.agentName,
      id: options.id,
    });
  });

memory
  .command("delete")
  .description("Delete a memory by ID")
  .requiredOption("--id <id>", "Memory ID")
  .option("--agent-name <name>", "Target agent name (boss token only)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    memoryDelete({
      token: options.token,
      agentName: options.agentName,
      id: options.id,
    });
  });

memory
  .command("delete-category")
  .description("Delete all memories in a category")
  .requiredOption("--category <category>", "Memory category")
  .option("--agent-name <name>", "Target agent name (boss token only)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    memoryDeleteCategory({
      token: options.token,
      agentName: options.agentName,
      category: options.category,
    });
  });

memory
  .command("clear")
  .description("Clear all memories for an agent (drops the table)")
  .option("--agent-name <name>", "Target agent name (boss token only)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    memoryClear({
      token: options.token,
      agentName: options.agentName,
    });
  });

memory
  .command("setup")
  .description("Configure the semantic memory embedding model")
  .option("--default", "Download and use the default model")
  .option("--model-path <path>", "Use a local GGUF model file")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    memorySetup({
      token: options.token,
      default: options.default,
      modelPath: options.modelPath,
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
  .option("--provider <provider>", "Provider (claude or codex)")
  .option("--model <model>", "Model name (provider-specific)")
  .option(
    "--reasoning-effort <effort>",
    "Reasoning effort (none, low, medium, high, xhigh)"
  )
  .option("--auto-level <level>", "Auto-approval level (low, medium, high)")
  .option(
    "--permission-level <level>",
    "Permission level (restricted, standard, privileged)"
  )
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
  .option("--metadata-json <json>", "Agent metadata JSON object")
  .option("--metadata-file <path>", "Path to agent metadata JSON file")
  .option("--bind-adapter-type <type>", "Bind adapter type at creation (e.g., telegram)")
  .option("--bind-adapter-token <token>", "Bind adapter token at creation (e.g., bot token)")
  .action((options) => {
    registerAgent({
      token: options.token,
      name: options.name,
      description: options.description,
      workspace: options.workspace,
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      autoLevel: options.autoLevel,
      permissionLevel: options.permissionLevel,
      sessionDailyResetAt: options.sessionDailyResetAt,
      sessionIdleTimeout: options.sessionIdleTimeout,
      sessionMaxTokens: options.sessionMaxTokens,
      metadataJson: options.metadataJson,
      metadataFile: options.metadataFile,
      bindAdapterType: options.bindAdapterType,
      bindAdapterToken: options.bindAdapterToken,
    });
  });

agent
  .command("set")
  .description("Update agent settings and bindings")
  .requiredOption("--name <name>", "Agent name")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .option("--description <description>", "Agent description")
  .option("--workspace <path>", "Workspace path for unified-agent-sdk")
  .option("--provider <provider>", "Provider (claude or codex)")
  .option("--model <model>", "Model name (provider-specific)")
  .option(
    "--reasoning-effort <effort>",
    "Reasoning effort (none, low, medium, high, xhigh)"
  )
  .option("--auto-level <level>", "Auto-approval level (low, medium, high)")
  .option(
    "--permission-level <level>",
    "Permission level (restricted, standard, privileged; boss token only)"
  )
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
  .option("--clear-session-policy", "Clear session policy")
  .option("--metadata-json <json>", "Agent metadata JSON object")
  .option("--metadata-file <path>", "Path to agent metadata JSON file")
  .option("--clear-metadata", "Clear agent metadata")
  .option("--bind-adapter-type <type>", "Bind adapter type (e.g., telegram)")
  .option("--bind-adapter-token <token>", "Bind adapter token (e.g., bot token)")
  .option("--unbind-adapter-type <type>", "Unbind adapter type (e.g., telegram)")
  .action((options) => {
    setAgent({
      token: options.token,
      name: options.name,
      description: options.description,
      workspace: options.workspace,
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      autoLevel: options.autoLevel,
      permissionLevel: options.permissionLevel,
      sessionDailyResetAt: options.sessionDailyResetAt,
      sessionIdleTimeout: options.sessionIdleTimeout,
      sessionMaxTokens: options.sessionMaxTokens,
      clearSessionPolicy: options.clearSessionPolicy,
      metadataJson: options.metadataJson,
      metadataFile: options.metadataFile,
      clearMetadata: options.clearMetadata,
      bindAdapterType: options.bindAdapterType,
      bindAdapterToken: options.bindAdapterToken,
      unbindAdapterType: options.unbindAdapterType,
    });
  });

agent
  .command("list")
  .description("List all agents")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    listAgents({ token: options.token });
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
  .description("Run setup from a JSON config file")
  .requiredOption("--config <path>", "Path to setup config JSON file")
  .action((options) => {
    runSetup(true, {
      config: options.config,
    });
  });

// Background command
program
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

// Helper to collect multiple values for an option
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export { program };
