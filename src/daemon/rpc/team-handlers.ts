import type {
  RpcMethodRegistry,
  TeamDeleteParams,
  TeamDeleteResult,
  TeamListParams,
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
  TeamStatusParams,
  TeamStatusResult,
} from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import type { Team } from "../../team/types.js";
import {
  AGENT_NAME_ERROR_MESSAGE,
  TEAM_NAME_ERROR_MESSAGE,
  isValidAgentName,
  isValidTeamName,
} from "../../shared/validation.js";
import { ensureTeamspaceDir, removeTeamspaceDir } from "../../team/teamspace.js";
import { errorMessage } from "../../shared/daemon-log.js";

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

      const ok = ctx.db.removeTeamMember({
        teamName: team.name,
        agentName: agent.name,
      });
      if (!ok) {
        rpcError(RPC_ERRORS.INTERNAL_ERROR, "Failed to remove team member");
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
