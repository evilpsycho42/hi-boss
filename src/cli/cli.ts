import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startDaemon,
  stopDaemon,
  daemonStatus,
  sendEnvelope,
  listEnvelopes,
  threadEnvelope,
  createCron,
  listCrons,
  enableCron,
  disableCron,
  deleteCron,
  setReaction,
  runSetup,
  runSetupConfigExport,
} from "./commands/index.js";
import { registerAgentCommands } from "./cli-agent.js";

function readPackageVersion(): string {
  // Works from both `src/` (dev) and `dist/` (built) by walking up until the
  // nearest package.json is found.
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // ignore and keep walking up
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "0.0.0";
}

const program = new Command();
const hibossVersion = readPackageVersion();

program
  .name("hiboss")
  .description("Hi-Boss: Agent-to-agent and agent-to-human communication daemon")
  .version(hibossVersion);
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
    "--reply-to <envelope-id>",
    "Reply to an envelope (optional; provides thread context; may quote for channels when possible)"
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

envelope
  .command("thread")
  .description("Show envelope thread (chain to root)")
  .requiredOption("--envelope-id <id>", "Envelope id (short id, longer prefix, or full UUID)")
  .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
  .action((options) => {
    threadEnvelope({
      token: options.token,
      envelopeId: options.envelopeId,
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
  .requiredOption("--envelope-id <id>", "Target channel envelope id (short id, prefix, or full UUID)")
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
      envelopeId: options.envelopeId,
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

registerAgentCommands(program);

const setup = program
  .command("setup")
  .description("Initial system configuration")
  .helpCommand(false)
  .allowExcessArguments(false)
  .option("--config-file <path>", "Run non-interactive setup from a JSON config file (version 2)")
  .option("--token <token>", "Boss token (required with --config-file; default: $HIBOSS_TOKEN)")
  .option("--dry-run", "Validate and preview --config-file changes without applying")
  .action((options) => {
    runSetup({
      configFile: options.configFile,
      token: options.token,
      dryRun: Boolean(options.dryRun),
    });
  });

setup
  .command("export")
  .description("Export current setup configuration to a JSON file (version 2)")
  .option("--out <path>", "Output path (default: $HIBOSS_DIR/config.json)")
  .action((options) => {
    runSetupConfigExport({ outputPath: options.out });
  });

// Helper to collect multiple values for an option
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export { program };
