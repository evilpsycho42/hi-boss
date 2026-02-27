import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { resolveToken } from "../token.js";
import type {
  TeamDeleteResult,
  TeamListResult,
  TeamMemberAddResult,
  TeamMemberRemoveResult,
  TeamRegisterResult,
  TeamSetResult,
  TeamStatusResult,
} from "../../daemon/ipc/types.js";
import {
  TEAM_NAME_ERROR_MESSAGE,
  AGENT_NAME_ERROR_MESSAGE,
  isValidAgentName,
  isValidTeamName,
} from "../../shared/validation.js";
import { formatUnixMsAsTimeZoneOffset } from "../../shared/time.js";
import { getDaemonTimeContext } from "../time-context.js";

export interface TeamRegisterOptions {
  token?: string;
  name: string;
  description?: string;
}

export interface TeamSetOptions {
  token?: string;
  name: string;
  description?: string | null;
  status?: "active" | "archived";
}

export interface TeamDeleteOptions {
  token?: string;
  name: string;
}

export interface TeamMemberOptions {
  token?: string;
  name: string;
  agent: string;
}

export interface TeamStatusOptions {
  token?: string;
  name: string;
}

export interface TeamListOptions {
  token?: string;
  status?: "active" | "archived";
}

function printTeamRecord(team: {
  name: string;
  description?: string;
  status: "active" | "archived";
  kind: "manual";
  createdAt: number;
  members: string[];
}, bossTimezone: string): void {
  console.log(`team-name: ${team.name}`);
  console.log(`team-status: ${team.status}`);
  console.log(`team-kind: ${team.kind}`);
  console.log(`description: ${team.description ?? "(none)"}`);
  console.log(`created-at: ${formatUnixMsAsTimeZoneOffset(team.createdAt, bossTimezone)}`);
  console.log(`members: ${team.members.length > 0 ? team.members.join(", ") : "(none)"}`);
}

export async function registerTeam(options: TeamRegisterOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    if (!isValidTeamName(options.name)) {
      throw new Error(TEAM_NAME_ERROR_MESSAGE);
    }

    const token = resolveToken(options.token);
    const time = await getDaemonTimeContext({ client, token });
    const result = await client.call<TeamRegisterResult>("team.register", {
      token,
      name: options.name,
      description: options.description,
    });

    console.log(`success: ${result.success ? "true" : "false"}`);
    printTeamRecord(result.team, time.bossTimezone);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function setTeam(options: TeamSetOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    if (!isValidTeamName(options.name)) {
      throw new Error(TEAM_NAME_ERROR_MESSAGE);
    }

    const token = resolveToken(options.token);
    const time = await getDaemonTimeContext({ client, token });
    const result = await client.call<TeamSetResult>("team.set", {
      token,
      teamName: options.name,
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
    });

    console.log(`success: ${result.success ? "true" : "false"}`);
    printTeamRecord(result.team, time.bossTimezone);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function deleteTeam(options: TeamDeleteOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    if (!isValidTeamName(options.name)) {
      throw new Error(TEAM_NAME_ERROR_MESSAGE);
    }

    const token = resolveToken(options.token);
    const result = await client.call<TeamDeleteResult>("team.delete", {
      token,
      teamName: options.name,
    });
    console.log(`success: ${result.success ? "true" : "false"}`);
    console.log(`team-name: ${result.teamName}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function addTeamMember(options: TeamMemberOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    if (!isValidTeamName(options.name)) {
      throw new Error(TEAM_NAME_ERROR_MESSAGE);
    }
    if (!isValidAgentName(options.agent)) {
      throw new Error(AGENT_NAME_ERROR_MESSAGE);
    }

    const token = resolveToken(options.token);
    const result = await client.call<TeamMemberAddResult>("team.add-member", {
      token,
      teamName: options.name,
      agentName: options.agent,
    });
    console.log(`success: ${result.success ? "true" : "false"}`);
    console.log(`team-name: ${result.teamName}`);
    console.log(`agent-name: ${result.agentName}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function removeTeamMember(options: TeamMemberOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    if (!isValidTeamName(options.name)) {
      throw new Error(TEAM_NAME_ERROR_MESSAGE);
    }
    if (!isValidAgentName(options.agent)) {
      throw new Error(AGENT_NAME_ERROR_MESSAGE);
    }

    const token = resolveToken(options.token);
    const result = await client.call<TeamMemberRemoveResult>("team.remove-member", {
      token,
      teamName: options.name,
      agentName: options.agent,
    });
    console.log(`success: ${result.success ? "true" : "false"}`);
    console.log(`team-name: ${result.teamName}`);
    console.log(`agent-name: ${result.agentName}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function teamStatus(options: TeamStatusOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    if (!isValidTeamName(options.name)) {
      throw new Error(TEAM_NAME_ERROR_MESSAGE);
    }

    const token = resolveToken(options.token);
    const time = await getDaemonTimeContext({ client, token });
    const result = await client.call<TeamStatusResult>("team.status", {
      token,
      teamName: options.name,
    });
    printTeamRecord(result.team, time.bossTimezone);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function listTeams(options: TeamListOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const time = await getDaemonTimeContext({ client, token });
    const result = await client.call<TeamListResult>("team.list", {
      token,
      ...(options.status ? { status: options.status } : {}),
    });

    if (result.teams.length === 0) {
      console.log("no-teams: true");
      return;
    }

    for (const team of result.teams) {
      printTeamRecord(team, time.bossTimezone);
      console.log();
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}
