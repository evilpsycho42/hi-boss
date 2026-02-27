/**
 * Session RPC handlers.
 *
 * Handles: session.list
 */

import type { RpcMethodRegistry, SessionListParams, SessionListResult } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../shared/validation.js";

export function createSessionHandlers(ctx: DaemonContext): RpcMethodRegistry {
  return {
    "session.list": async (params) => {
      const p = params as unknown as SessionListParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("session.list", principal);

      const agentNameInput =
        typeof p.agentName === "string" && p.agentName.trim().length > 0 ? p.agentName.trim() : undefined;
      if (agentNameInput !== undefined && !isValidAgentName(agentNameInput)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, AGENT_NAME_ERROR_MESSAGE);
      }

      const targetAgentName = agentNameInput ?? (principal.kind === "agent" ? principal.agent.name : undefined);
      if (!targetAgentName) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "agent-name is required");
      }

      const targetAgent = ctx.db.getAgentByNameCaseInsensitive(targetAgentName);
      if (!targetAgent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }

      const limit = (() => {
        if (p.limit === undefined || p.limit === null) return 20;
        if (typeof p.limit !== "number" || !Number.isFinite(p.limit)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit");
        }
        const normalized = Math.trunc(p.limit);
        if (normalized <= 0 || normalized > 100) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit (expected 1..100)");
        }
        return normalized;
      })();

      const sessions = ctx.db.listAgentSessionsByAgent(targetAgent.name, limit);

      const result: SessionListResult = {
        sessions: sessions.map((item) => ({
          id: item.id,
          agentName: item.agentName,
          provider: item.provider,
          providerSessionId: item.providerSessionId,
          createdAt: item.createdAt,
          lastActiveAt: item.lastActiveAt,
          lastAdapterType: item.lastAdapterType,
          lastChatId: item.lastChatId,
        })),
      };
      return result;
    },
  };
}

