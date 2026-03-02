import type {
  RpcMethodRegistry,
  TeamDeleteParams,
  TeamDeleteResult,
  TeamListParams,
  TeamListMembersParams,
  TeamListMembersResult,
  TeamListResult,
  TeamMemberAddParams,
  TeamMemberAddResult,
  TeamMemberRemoveParams,
  TeamMemberRemoveResult,
  TeamRecordResult,
  TeamRegisterParams,
  TeamRegisterResult,
  TeamSetParams,
  TeamSetResult,
  TeamSendParams,
  TeamSendResult,
  TeamStatusParams,
  TeamStatusResult,
} from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import type { Team } from "../../team/types.js";
import { formatAgentAddress } from "../../adapters/types.js";
import {
  AGENT_NAME_ERROR_MESSAGE,
  TEAM_NAME_ERROR_MESSAGE,
  isValidAgentName,
  isValidTeamName,
} from "../../shared/validation.js";
import { ensureTeamspaceDir, removeTeamspaceDir } from "../../team/teamspace.js";
import { errorMessage } from "../../shared/daemon-log.js";
import { sendEnvelopeFromAgent } from "./envelope-send-core.js";
import { validateTeamSendParams } from "./team-send-params.js";
import { computeTeamChatId } from "../../shared/chat-scope.js";

function requestSessionContextReloadForAgents(
  ctx: DaemonContext,
  agentNames: string[],
  reason: string,
): void {
  const unique = Array.from(
    new Set(
      agentNames
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
  );
  for (const agentName of unique) {
    ctx.executor.requestSessionContextReload(agentName, reason);
  }
}

function toTeamRecordResult(ctx: DaemonContext, team: Team): TeamRecordResult {
  return {
    name: team.name,
    description: team.description ?? undefined,
    status: team.status,
    kind: team.kind,
    createdAt: team.createdAt,
    members: ctx.db.listTeamMemberAgentNames(team.name),
  };
}

export function createTeamHandlers(ctx: DaemonContext): RpcMethodRegistry {
  return {
    "team.register": async (params): Promise<TeamRegisterResult> => {
      const p = params as unknown as TeamRegisterParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("team.register", principal);

      if (typeof p.name !== "string" || !isValidTeamName(p.name.trim())) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, TEAM_NAME_ERROR_MESSAGE);
      }
      if (p.description !== undefined && typeof p.description !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid description");
      }

      const team = ctx.db.createTeam({
        name: p.name.trim(),
        description: p.description,
      });

      const ensured = ensureTeamspaceDir({
        hibossDir: ctx.config.dataDir,
        teamName: team.name,
      });
      if (!ensured.ok) {
        ctx.db.deleteTeam(team.name);
        rpcError(
          RPC_ERRORS.INTERNAL_ERROR,
          `Failed to initialize teamspace for team "${team.name}": ${ensured.error}`
        );
      }

      return {
        success: true,
        team: toTeamRecordResult(ctx, team),
      };
    },

    "team.set": async (params): Promise<TeamSetResult> => {
      const p = params as unknown as TeamSetParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("team.set", principal);

      if (typeof p.teamName !== "string" || !isValidTeamName(p.teamName.trim())) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, TEAM_NAME_ERROR_MESSAGE);
      }

      if (p.description !== undefined && p.description !== null && typeof p.description !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid description");
      }
      if (p.status !== undefined && p.status !== "active" && p.status !== "archived") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid status");
      }

      const team = ctx.db.getTeamByNameCaseInsensitive(p.teamName.trim());
      if (!team) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Team not found");
      }

      const updated = ctx.db.updateTeam(team.name, {
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.status !== undefined ? { status: p.status } : {}),
      });
      if (team.status !== updated.status) {
        requestSessionContextReloadForAgents(
          ctx,
          ctx.db.listTeamMemberAgentNames(updated.name),
          `rpc:team.set:status:${team.status}->${updated.status}:${updated.name}`,
        );
      }

      return {
        success: true,
        team: toTeamRecordResult(ctx, updated),
      };
    },

    "team.delete": async (params): Promise<TeamDeleteResult> => {
      const p = params as unknown as TeamDeleteParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("team.delete", principal);

      if (typeof p.teamName !== "string" || !isValidTeamName(p.teamName.trim())) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, TEAM_NAME_ERROR_MESSAGE);
      }

      const team = ctx.db.getTeamByNameCaseInsensitive(p.teamName.trim());
      if (!team) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Team not found");
      }
      const membersBeforeDelete = ctx.db.listTeamMemberAgentNames(team.name);

      const removed = removeTeamspaceDir({
        hibossDir: ctx.config.dataDir,
        teamName: team.name,
      });
      if (!removed.ok) {
        rpcError(
          RPC_ERRORS.INTERNAL_ERROR,
          `Failed to remove teamspace for team "${team.name}": ${removed.error}`
        );
      }

      const ok = ctx.db.deleteTeam(team.name);
      if (!ok) {
        rpcError(RPC_ERRORS.INTERNAL_ERROR, "Failed to delete team");
      }
      if (team.status === "active") {
        requestSessionContextReloadForAgents(
          ctx,
          membersBeforeDelete,
          `rpc:team.delete:${team.name}`,
        );
      }

      return {
        success: true,
        teamName: team.name,
      };
    },

    "team.add-member": async (params): Promise<TeamMemberAddResult> => {
      const p = params as unknown as TeamMemberAddParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("team.add-member", principal);

      if (typeof p.teamName !== "string" || !isValidTeamName(p.teamName.trim())) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, TEAM_NAME_ERROR_MESSAGE);
      }
      if (typeof p.agentName !== "string" || !isValidAgentName(p.agentName.trim())) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, AGENT_NAME_ERROR_MESSAGE);
      }

      const team = ctx.db.getTeamByNameCaseInsensitive(p.teamName.trim());
      if (!team) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Team not found");
      }
      const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName.trim());
      if (!agent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }

      const existing = ctx.db.getTeamMember(team.name, agent.name);
      if (existing) {
        rpcError(RPC_ERRORS.ALREADY_EXISTS, "Member already exists");
      }

      try {
        ctx.db.addTeamMember({
          teamName: team.name,
          agentName: agent.name,
          source: "manual",
        });
      } catch (err) {
        rpcError(RPC_ERRORS.INTERNAL_ERROR, errorMessage(err));
      }
      if (team.status === "active") {
        requestSessionContextReloadForAgents(
          ctx,
          ctx.db.listTeamMemberAgentNames(team.name),
          `rpc:team.add-member:${team.name}`,
        );
      }

      return {
        success: true,
        teamName: team.name,
        agentName: agent.name,
      };
    },

    "team.remove-member": async (params): Promise<TeamMemberRemoveResult> => {
      const p = params as unknown as TeamMemberRemoveParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("team.remove-member", principal);

      if (typeof p.teamName !== "string" || !isValidTeamName(p.teamName.trim())) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, TEAM_NAME_ERROR_MESSAGE);
      }
      if (typeof p.agentName !== "string" || !isValidAgentName(p.agentName.trim())) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, AGENT_NAME_ERROR_MESSAGE);
      }

      const team = ctx.db.getTeamByNameCaseInsensitive(p.teamName.trim());
      if (!team) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Team not found");
      }
      const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName.trim());
      if (!agent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }

      const existing = ctx.db.getTeamMember(team.name, agent.name);
      if (!existing) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Member not found");
      }
      const membersBeforeRemove = ctx.db.listTeamMemberAgentNames(team.name);

      const ok = ctx.db.removeTeamMember({
        teamName: team.name,
        agentName: agent.name,
      });
      if (!ok) {
        rpcError(RPC_ERRORS.INTERNAL_ERROR, "Failed to remove team member");
      }
      if (team.status === "active") {
        requestSessionContextReloadForAgents(
          ctx,
          membersBeforeRemove,
          `rpc:team.remove-member:${team.name}`,
        );
      }

      return {
        success: true,
        teamName: team.name,
        agentName: agent.name,
      };
    },

    "team.status": async (params): Promise<TeamStatusResult> => {
      const p = params as unknown as TeamStatusParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("team.status", principal);

      if (typeof p.teamName !== "string" || !isValidTeamName(p.teamName.trim())) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, TEAM_NAME_ERROR_MESSAGE);
      }

      const team = ctx.db.getTeamByNameCaseInsensitive(p.teamName.trim());
      if (!team) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Team not found");
      }

      return {
        team: toTeamRecordResult(ctx, team),
      };
    },

    "team.list-members": async (params): Promise<TeamListMembersResult> => {
      const p = params as unknown as TeamListMembersParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("team.list-members", principal);

      if (typeof p.teamName !== "string" || !isValidTeamName(p.teamName.trim())) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, TEAM_NAME_ERROR_MESSAGE);
      }

      const team = ctx.db.getTeamByNameCaseInsensitive(p.teamName.trim());
      if (!team) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Team not found");
      }

      const members = ctx.db.listTeamMembers(team.name);
      return {
        teamName: team.name,
        members: members.map((member) => ({
          agentName: member.agentName,
          source: member.source,
          createdAt: member.createdAt,
        })),
      };
    },

    "team.send": async (params): Promise<TeamSendResult> => {
      const p = params as unknown as TeamSendParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("team.send", principal);

      if (principal.kind === "admin") {
        rpcError(
          RPC_ERRORS.UNAUTHORIZED,
          "Admin tokens cannot send envelopes (use an agent token or send via a channel adapter)"
        );
      }

      if (typeof p.teamName !== "string" || !isValidTeamName(p.teamName.trim())) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, TEAM_NAME_ERROR_MESSAGE);
      }

      const team = ctx.db.getTeamByNameCaseInsensitive(p.teamName.trim());
      if (!team) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Team not found");
      }
      if (team.status !== "active") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Cannot send to archived team");
      }

      validateTeamSendParams(ctx, p);

      const sender = principal.agent;
      ctx.db.updateAgentLastSeen(sender.name);
      const recipients = Array.from(
        new Set(
          ctx.db
            .listTeamMemberAgentNames(team.name)
            .filter((name) => name !== sender.name),
        ),
      );
      if (recipients.length === 0) {
        return {
          teamName: team.name,
          requestedCount: 0,
          sentCount: 0,
          failedCount: 0,
          results: [],
        };
      }

      const results: TeamSendResult["results"] = [];
      for (const agentName of recipients) {
        try {
          const sendResult = await sendEnvelopeFromAgent({
            ctx,
            senderAgent: sender,
            input: {
              to: formatAgentAddress(agentName),
              chatScope: computeTeamChatId(team.name),
              text: p.text,
              attachments: p.attachments,
              deliverAt: p.deliverAt,
              interruptNow: p.interruptNow,
              replyToEnvelopeId: p.replyToEnvelopeId,
              origin: p.origin,
            },
            interruptReason: "rpc:team.send:interrupt-now",
          });
          if (!("id" in sendResult) || typeof sendResult.id !== "string" || !sendResult.id.trim()) {
            throw new Error("Unexpected team.send result: missing envelope id");
          }
          results.push({
            agentName,
            success: true,
            envelopeId: sendResult.id,
            interruptedWork: sendResult.interruptedWork,
          });
        } catch (err) {
          results.push({
            agentName,
            success: false,
            error: errorMessage(err),
          });
        }
      }

      const sentCount = results.filter((item) => item.success).length;
      const failedCount = results.length - sentCount;
      return {
        teamName: team.name,
        requestedCount: recipients.length,
        sentCount,
        failedCount,
        results,
      };
    },

    "team.list": async (params): Promise<TeamListResult> => {
      const p = params as unknown as TeamListParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("team.list", principal);

      if (p.status !== undefined && p.status !== "active" && p.status !== "archived") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid status");
      }

      const teams = ctx.db.listTeams({
        ...(p.status ? { status: p.status } : {}),
      });
      return {
        teams: teams.map((team) => toTeamRecordResult(ctx, team)),
      };
    },
  };
}
