/**
 * Turn preview RPC handlers.
 */

import type { RpcMethodRegistry, TurnPreviewParams } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";

/**
 * Create turn RPC handlers.
 */
export function createTurnHandlers(ctx: DaemonContext): RpcMethodRegistry {
  const createTurnPreview = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as TurnPreviewParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    let agentName: string;
    if (principal.kind === "boss") {
      if (typeof p.agentName !== "string" || !p.agentName.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Boss token requires agentName");
      }
      const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName.trim());
      if (!agent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }
      agentName = agent.name;
    } else {
      if (p.agentName !== undefined) {
        rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
      }
      ctx.db.updateAgentLastSeen(principal.agent.name);
      agentName = principal.agent.name;
    }

    let limit = 10;
    if (p.limit !== undefined) {
      if (typeof p.limit !== "number" || !Number.isFinite(p.limit)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit");
      }
      if (p.limit <= 0) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit (must be > 0)");
      }
      limit = Math.trunc(p.limit);
    }

    const envelopes = ctx.db.getPendingEnvelopesForAgent(agentName, limit);
    return { agentName, datetimeIso: new Date().toISOString(), envelopes };
  };

  return {
    "turn.preview": createTurnPreview("turn.preview"),
  };
}
