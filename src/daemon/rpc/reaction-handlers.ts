/**
 * Reaction RPC handlers.
 */

import type { RpcMethodRegistry, ReactionSetParams } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import { parseAddress } from "../../adapters/types.js";

/**
 * Create reaction RPC handlers.
 */
export function createReactionHandlers(ctx: DaemonContext): RpcMethodRegistry {
  const createReactionSet = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as ReactionSetParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    if (principal.kind !== "agent") {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
    }

    if (typeof p.to !== "string" || !p.to.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid to");
    }

    let destination: ReturnType<typeof parseAddress>;
    try {
      destination = parseAddress(p.to);
    } catch (err) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, err instanceof Error ? err.message : "Invalid to");
    }
    if (destination.type !== "channel") {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Reaction targets must be channel:<adapter>:<chat-id>");
    }

    if (typeof p.messageId !== "string" || !p.messageId.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid message-id");
    }
    if (typeof p.emoji !== "string" || !p.emoji.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid emoji");
    }

    const agent = principal.agent;
    ctx.db.updateAgentLastSeen(agent.name);

    const binding = ctx.db.getAgentBindingByType(agent.name, destination.adapter);
    if (!binding) {
      rpcError(
        RPC_ERRORS.UNAUTHORIZED,
        `Agent '${agent.name}' is not bound to adapter '${destination.adapter}'`
      );
    }

    const adapter = ctx.adapters.get(binding.adapterToken);
    if (!adapter) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, `Adapter not loaded: ${destination.adapter}`);
    }
    if (!adapter.setReaction) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, `Adapter '${destination.adapter}' does not support reactions`);
    }

    await adapter.setReaction(destination.chatId, p.messageId.trim(), p.emoji.trim());
    return { success: true };
  };

  return {
    "reaction.set": createReactionSet("reaction.set"),
  };
}
