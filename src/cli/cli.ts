import { Command } from "commander";
import {
  startDaemon,
  stopDaemon,
  daemonStatus,
  sendEnvelope,
  listEnvelopes,
  createCron,
  listCrons,
  enableCron,
  disableCron,
  deleteCron,
  setReaction,
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
import { registerAgentCommands } from "./cli-agent.js";

const program = new Command();

program
  .name("hiboss")
  .description("Hi-Boss: Agent-to-agent and agent-to-human communication daemon")
  .version("1.0.0");
program.helpCommand(false);

// Daemon commands
const daemon = program
  .command("daemon")
  .description("Daemon management")
  .helpCommand(false);

daemon
  .command("start")
  .description("Start the daemon")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .option("--debug", "Include debug fields in daemon.log")
  .action((options) => {
    startDaemon({ token: options.token, debug: Boolean(options.debug) });
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
const envelope = program
  .command("envelope")
  .description("Envelope operations")
  .helpCommand(false);

envelope
  .command("send")
  .description("Send an envelope")
  .requiredOption(
    "--to <address>",
    "Destination address (agent:<name> or channel:<adapter>:<chat-id>)"
  )
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .option("--text <text>", "Envelope text (use - to read from stdin)")
  .option("--text-file <path>", "Read envelope text from file")
  .option("--attachment <path>", "Attachment path (can be used multiple times)", collect, [])
  .option("--parse-mode <mode>", "Parse mode (Telegram): plain (default), html (recommended), markdownv2")
  .option(
    "--reply-to <channel-message-id>",
    "Reply/quote a channel message (optional; Telegram: use the base36 id shown as channel-message-id)"
  )
  .option(
    "--deliver-at <time>",
    "Schedule delivery time (ISO 8601 or relative: +2h, +30m, +1Y2M, -15m; units: Y/M/D/h/m/s)"
  )
  .addHelpText(
    "after",
    [
      "",
      "Notes:",
      "  - Default is plain text. Use --parse-mode html for long or formatted messages (bold/italic/links; structured blocks via <pre>/<code>, incl. ASCII tables).",
      "  - Use --parse-mode markdownv2 only if you can escape special characters correctly.",
      "  - Most Telegram users reply without quoting; only use --reply-to when it prevents confusion (busy groups, multiple questions).",
      "",
    ].join("\n")
  )
  .action((options) => {
    sendEnvelope({
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
const reaction = program
  .command("reaction")
  .description("Message reactions")
  .helpCommand(false);

reaction
  .command("set")
  .description("Set a reaction on a channel message")
  .requiredOption("--to <address>", "Target channel address (channel:<adapter>:<chat-id>)")
  .requiredOption(
    "--channel-message-id <id>",
    "Target channel message id on the platform (Telegram: use the base36 id shown as channel-message-id)"
  )
  .requiredOption("--emoji <emoji>", "Reaction emoji (e.g., 👍)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .addHelpText(
    "after",
    [
      "",
      "Notes:",
      "  - Reactions are Telegram emoji reactions (not a text reply).",
      "  - Use sparingly: agreement, appreciation, or to keep the vibe friendly.",
      "",
    ].join("\n")
  )
  .action((options) => {
    setReaction({
      token: options.token,
      to: options.to,
      messageId: options.channelMessageId,
      emoji: options.emoji,
    });
  });

envelope
  .command("list")
  .description("List envelopes")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .option("--to <address>", "List envelopes you sent to an address")
  .option("--from <address>", "List envelopes sent to you from an address")
  .requiredOption(
    "--status <status>",
    "pending or done (note: --from + pending ACKs what is returned; marks done)"
  )
  .option("-n, --limit <n>", "Maximum number of results (default 10, max 50)", parseInt, 10)
  .addHelpText(
    "after",
    "\nNotes:\n  - Listing with --from <address> --status pending ACKs what is returned (marks those envelopes done).\n  - Default limit is 10; maximum is 50.\n"
  )
  .action((options) => {
    listEnvelopes({
      token: options.token,
      to: options.to,
      from: options.from,
      status: options.status as "pending" | "done",
      limit: options.limit,
    });
  });

// Cron commands
const cron = program
  .command("cron")
  .description("Cron schedules (materialize scheduled envelopes)")
  .helpCommand(false);

cron
  .command("create")
  .description("Create a cron schedule")
  .requiredOption(
    "--cron <expr>",
    "Cron expression (5-field or 6-field with seconds; supports @daily, @hourly, ...)"
  )
  .requiredOption(
    "--to <address>",
    "Destination address (agent:<name> or channel:<adapter>:<chat-id>)"
  )
  .option("--timezone <iana>", "IANA timezone (defaults to boss timezone)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .option("--text <text>", "Envelope text (use - to read from stdin)")
  .option("--text-file <path>", "Read envelope text from file")
  .option("--attachment <path>", "Attachment path (can be used multiple times)", collect, [])
  .option("--parse-mode <mode>", "Parse mode (Telegram): plain (default), html (recommended), markdownv2")
  .addHelpText(
    "after",
    ["", "Notes:", "  - For formatting guidance, see: hiboss envelope send --help", ""].join("\n")
  )
  .action((options) => {
    createCron({
      cron: options.cron,
      timezone: options.timezone,
      to: options.to,
      token: options.token,
      text: options.text,
      textFile: options.textFile,
      attachment: options.attachment,
      parseMode: options.parseMode,
    });
  });

cron
  .command("list")
  .description("List cron schedules for this agent")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    listCrons({ token: options.token });
  });

cron
  .command("enable")
  .description(
    "Enable a cron schedule (cancels any pending instance and schedules the next one)"
  )
  .requiredOption("--id <id>", "Cron schedule ID")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    enableCron({ id: options.id, token: options.token });
  });

cron
  .command("disable")
  .description("Disable a cron schedule (cancels the pending instance)")
  .requiredOption("--id <id>", "Cron schedule ID")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    disableCron({ id: options.id, token: options.token });
  });

cron
  .command("delete")
  .description("Delete a cron schedule (cancels the pending instance)")
  .requiredOption("--id <id>", "Cron schedule ID")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    deleteCron({ id: options.id, token: options.token });
  });

// Memory commands
const memory = program
  .command("memory")
  .description("Semantic memory operations")
  .helpCommand(false);

memory
  .command("add")
  .description("Add a memory (optional --category; default: fact)")
  .requiredOption("--text <text>", "Memory text")
  .option("--category <category>", "Optional category (default: fact)")
  .option(
    "--token <token>",
    "Token (default: $HIBOSS_TOKEN; agents usually omit; override via --token)"
  )
  .action((options) => {
    memoryAdd({
      token: options.token,
      text: options.text,
      category: options.category,
    });
  });

memory
  .command("search")
  .description("Search memories by semantic similarity (optional --category)")
  .requiredOption("--query <query>", "Search query")
  .option("--category <category>", "Optional category filter")
  .option("-n, --limit <n>", "Maximum number of results", parseInt)
  .option(
    "--token <token>",
    "Token (default: $HIBOSS_TOKEN; agents usually omit; override via --token)"
  )
  .action((options) => {
    memorySearch({
      token: options.token,
      query: options.query,
      category: options.category,
      limit: options.limit,
    });
  });

memory
  .command("list")
  .description("List stored memories (newest-first)")
  .option("--category <category>", "Optional category filter")
  .option("-n, --limit <n>", "Maximum number of results", parseInt)
  .option(
    "--token <token>",
    "Token (default: $HIBOSS_TOKEN; agents usually omit; override via --token)"
  )
  .action((options) => {
    memoryList({
      token: options.token,
      category: options.category,
      limit: options.limit,
    });
  });

memory
  .command("categories")
  .description("List known memory categories (from stored memories)")
  .option(
    "--token <token>",
    "Token (default: $HIBOSS_TOKEN; agents usually omit; override via --token)"
  )
  .action((options) => {
    memoryCategories({
      token: options.token,
    });
  });

memory
  .command("get")
  .description("Get a memory by ID")
  .requiredOption("--id <id>", "Memory ID")
  .option(
    "--token <token>",
    "Token (default: $HIBOSS_TOKEN; agents usually omit; override via --token)"
  )
  .action((options) => {
    memoryGet({
      token: options.token,
      id: options.id,
    });
  });

memory
  .command("delete")
  .description("Delete a memory by ID")
  .requiredOption("--id <id>", "Memory ID")
  .option(
    "--token <token>",
    "Token (default: $HIBOSS_TOKEN; agents usually omit; override via --token)"
  )
  .action((options) => {
    memoryDelete({
      token: options.token,
      id: options.id,
    });
  });

memory
  .command("delete-category")
  .description("Delete all memories in a category")
  .requiredOption("--category <category>", "Memory category")
  .option(
    "--token <token>",
    "Token (default: $HIBOSS_TOKEN; agents usually omit; override via --token)"
  )
  .action((options) => {
    memoryDeleteCategory({
      token: options.token,
      category: options.category,
    });
  });

memory
  .command("clear")
  .description("Clear all memories for an agent (drops the table)")
  .option(
    "--token <token>",
    "Token (default: $HIBOSS_TOKEN; agents usually omit; override via --token)"
  )
  .action((options) => {
    memoryClear({
      token: options.token,
    });
  });

memory
  .command("setup")
  .description("Configure the semantic memory embedding model")
  .option("--default", "Download and use the default model")
  .option("--model-path <path>", "Use a local GGUF model file")
  .option(
    "--token <token>",
    "Token (default: $HIBOSS_TOKEN; agents usually omit; override via --token)"
  )
  .action((options) => {
    memorySetup({
      token: options.token,
      default: options.default,
      modelPath: options.modelPath,
    });
  });

registerAgentCommands(program);

program
  .command("setup")
  .description("Initial system configuration")
  .allowExcessArguments(false)
  .option("--config-file <path>", "Run non-interactive setup from a JSON config file")
  .action((options) => {
    runSetup({ configFile: options.configFile });
  });

// Helper to collect multiple values for an option
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export { program };
