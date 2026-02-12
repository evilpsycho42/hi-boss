import type { Command } from "commander";
import { registerAgent, setAgent, listAgents, deleteAgent, agentStatus, abortAgent } from "./commands/index.js";

export function registerAgentCommands(program: Command): void {
  // Agent commands
  const agent = program.command("agent").description("Agent management");

  // Remove `hiboss agent help` (keep `hiboss agent --help` / `-h`).
  // Commander has both `helpCommand` and `addHelpCommand` APIs across versions; disable defensively.
  if (typeof (agent as any).helpCommand === "function") {
    (agent as any).helpCommand(false);
  }
  if (typeof (agent as any).addHelpCommand === "function") {
    (agent as any).addHelpCommand(false);
  }

  agent
    .command("register")
    .description("Register a new agent")
    .requiredOption("--name <name>", "Agent name (alphanumeric with hyphens)")
    .requiredOption("--role <role>", "Agent role (speaker or leader)")
    .requiredOption("--provider <provider>", "Provider (claude or codex)")
    .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
    .option("--description <description>", "Agent description")
    .option("--workspace <path>", "Workspace directory for provider CLI runs")
    .option("--model <model>", "Model name (provider-specific)")
    .option(
      "--reasoning-effort <effort>",
      "Reasoning effort (default, none, low, medium, high, xhigh)"
    )
    .option(
      "--permission-level <level>",
      "Permission level (restricted, standard, privileged, boss)"
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
      "--session-max-context-length <n>",
      "Refresh session after a run's context length exceeds N tokens",
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
        role: options.role,
        description: options.description,
        workspace: options.workspace,
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        permissionLevel: options.permissionLevel,
        sessionDailyResetAt: options.sessionDailyResetAt,
        sessionIdleTimeout: options.sessionIdleTimeout,
        sessionMaxContextLength: options.sessionMaxContextLength,
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
    .option("--role <role>", "Agent role (speaker or leader)")
    .option("--description <description>", "Agent description")
    .option("--workspace <path>", "Workspace directory for provider CLI runs")
    .option("--provider <provider>", "Provider (claude or codex)")
    .option(
      "--model <model>",
      "Model override (provider-specific; use 'default' to clear)"
    )
    .option(
      "--reasoning-effort <effort>",
      "Reasoning effort (default, none, low, medium, high, xhigh)"
    )
    .option(
      "--permission-level <level>",
      "Permission level (restricted, standard, privileged, boss; boss-privileged only)"
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
      "--session-max-context-length <n>",
      "Refresh session after a run's context length exceeds N tokens",
      parseInt
    )
    .option("--clear-session-policy", "Clear session policy")
    .option("--metadata-json <json>", "Agent metadata JSON object")
    .option("--metadata-file <path>", "Path to agent metadata JSON file")
    .option("--clear-metadata", "Clear agent metadata")
    .option(
      "--bind-adapter-type <type>",
      "Bind/replace adapter type (e.g., telegram)"
    )
    .option(
      "--bind-adapter-token <token>",
      "Bind/replace adapter token (e.g., bot token)"
    )
    .option("--unbind-adapter-type <type>", "Unbind adapter type (e.g., telegram)")
    .action((options) => {
      setAgent({
        token: options.token,
        name: options.name,
        role: options.role,
        description: options.description,
        workspace: options.workspace,
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        permissionLevel: options.permissionLevel,
        sessionDailyResetAt: options.sessionDailyResetAt,
        sessionIdleTimeout: options.sessionIdleTimeout,
        sessionMaxContextLength: options.sessionMaxContextLength,
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

  agent
    .command("delete")
    .description("Delete an agent")
    .requiredOption("--name <name>", "Agent name")
    .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
    .action((options) => {
      deleteAgent({ token: options.token, name: options.name });
    });

  agent
    .command("status")
    .description("Show runtime status for an agent")
    .requiredOption("--name <name>", "Agent name")
    .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
    .action((options) => {
      agentStatus({ token: options.token, name: options.name });
    });

  agent
    .command("abort")
    .description("Cancel current run and clear pending inbox for an agent")
    .requiredOption("--name <name>", "Agent name")
    .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
    .action((options) => {
      abortAgent({ token: options.token, name: options.name });
    });
}
