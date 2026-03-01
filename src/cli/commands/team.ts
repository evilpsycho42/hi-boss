import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { resolveToken } from "../token.js";
import type {
  TeamDeleteResult,
  TeamListResult,
  TeamListMembersResult,
  TeamMemberAddResult,
  TeamMemberRemoveResult,
  TeamRegisterResult,
  TeamSendResult,
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
import { formatShortId } from "../../shared/id-format.js";
import { extractTelegramFileId, normalizeAttachmentSource, resolveText } from "./envelope-input.js";

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

export interface TeamListMembersOptions {
  token?: string;
  name: string;
}

export interface TeamSendOptions {
  token?: string;
  name: string;
  text?: string;
  textFile?: string;
  attachment?: string[];
  deliverAt?: string;
  interruptNow?: boolean;
  replyTo?: string;
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

export async function listTeamMembers(options: TeamListMembersOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    if (!isValidTeamName(options.name)) {
      throw new Error(TEAM_NAME_ERROR_MESSAGE);
    }

    const token = resolveToken(options.token);
    const time = await getDaemonTimeContext({ client, token });
    const result = await client.call<TeamListMembersResult>("team.list-members", {
      token,
      teamName: options.name,
    });

    console.log(`team-name: ${result.teamName}`);
    console.log(`member-count: ${result.members.length}`);
    if (result.members.length === 0) {
      console.log("no-members: true");
      return;
    }

    for (const member of result.members) {
      console.log(`agent-name: ${member.agentName}`);
      console.log(`source: ${member.source}`);
      console.log(`joined-at: ${formatUnixMsAsTimeZoneOffset(member.createdAt, time.bossTimezone)}`);
      console.log();
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function sendTeam(options: TeamSendOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    if (!isValidTeamName(options.name)) {
      throw new Error(TEAM_NAME_ERROR_MESSAGE);
    }

    const token = resolveToken(options.token);
    const text = await resolveText(options.text, options.textFile);
    const result = await client.call<TeamSendResult>("team.send", {
      token,
      teamName: options.name,
      text,
      attachments: options.attachment?.map((source) => {
        const telegramFileId = extractTelegramFileId(source);
        return {
          source: normalizeAttachmentSource(source),
          ...(telegramFileId ? { telegramFileId } : {}),
        };
      }),
      deliverAt: options.deliverAt,
      interruptNow: options.interruptNow,
      replyToEnvelopeId: options.replyTo,
    });

    console.log(`team-name: ${result.teamName}`);
    console.log(`requested-count: ${result.requestedCount}`);
    console.log(`sent-count: ${result.sentCount}`);
    console.log(`failed-count: ${result.failedCount}`);
    if (result.requestedCount === 0) {
      console.log("no-recipients: true");
      return;
    }

    for (const item of result.results) {
      console.log(`agent-name: ${item.agentName}`);
      console.log(`status: ${item.success ? "sent" : "failed"}`);
      console.log(`id: ${item.envelopeId ? formatShortId(item.envelopeId) : "none"}`);
      console.log(`error: ${item.error ?? "none"}`);
      console.log();
    }

    if (result.failedCount > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}
