import type { Command } from "commander";
import {
  addTeamMember,
  deleteTeam,
  listTeams,
  registerTeam,
  removeTeamMember,
  setTeam,
  teamStatus,
} from "./commands/index.js";

export function registerTeamCommands(program: Command): void {
  const team = program.command("team").description("Team management");

  if (typeof (team as any).helpCommand === "function") {
    (team as any).helpCommand(false);
  }
  if (typeof (team as any).addHelpCommand === "function") {
    (team as any).addHelpCommand(false);
  }

  team
    .command("register")
    .description("Create a team and initialize its teamspace")
    .requiredOption("--name <name>", "Team name (alphanumeric with hyphens)")
    .option("--description <description>", "Team description")
    .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
    .action((options) => {
      registerTeam({
        token: options.token,
        name: options.name,
        description: options.description,
      });
    });

  team
    .command("set")
    .description("Update team metadata")
    .requiredOption("--name <name>", "Team name")
    .option("--description <description>", "Team description")
    .option("--clear-description", "Clear description")
    .option("--status <status>", "Team status (active|archived)")
    .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
    .action((options) => {
      const description =
        options.clearDescription ? null : options.description;
      setTeam({
        token: options.token,
        name: options.name,
        ...(description !== undefined ? { description } : {}),
        status: options.status,
      });
    });

  team
    .command("delete")
    .description("Delete a team and remove its teamspace directory")
    .requiredOption("--name <name>", "Team name")
    .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
    .action((options) => {
      deleteTeam({
        token: options.token,
        name: options.name,
      });
    });

  team
    .command("add-member")
    .description("Add an agent to a team")
    .requiredOption("--name <name>", "Team name")
    .requiredOption("--agent <agent>", "Agent name")
    .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
    .action((options) => {
      addTeamMember({
        token: options.token,
        name: options.name,
        agent: options.agent,
      });
    });

  team
    .command("remove-member")
    .description("Remove an agent from a team")
    .requiredOption("--name <name>", "Team name")
    .requiredOption("--agent <agent>", "Agent name")
    .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
    .action((options) => {
      removeTeamMember({
        token: options.token,
        name: options.name,
        agent: options.agent,
      });
    });

  team
    .command("status")
    .description("Show team details")
    .requiredOption("--name <name>", "Team name")
    .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
    .action((options) => {
      teamStatus({
        token: options.token,
        name: options.name,
      });
    });

  team
    .command("list")
    .description("List teams")
    .option("--status <status>", "Filter by status (active|archived)")
    .option("--token <token>", "Token (defaults to HIBOSS_TOKEN)")
    .action((options) => {
      listTeams({
        token: options.token,
        status: options.status,
      });
    });
}
