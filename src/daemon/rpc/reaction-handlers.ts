/**
 * Reaction RPC handlers.
 */

import type { RpcMethodRegistry, ReactionSetParams } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import { parseAddress } from "../../adapters/types.js";
import { resolveEnvelopeIdInput } from "./resolve-envelope-id.js";
import { formatTelegramMessageIdCompact } from "../../shared/telegram-message-id.js";

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

    if (typeof p.envelopeId !== "string" || !p.envelopeId.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid envelope-id");
    }

    if (typeof p.emoji !== "string" || !p.emoji.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid emoji");
    }

    const agent = principal.agent;
    ctx.db.updateAgentLastSeen(agent.name);

    const resolved = resolveEnvelopeIdInput(ctx.db, p.envelopeId.trim());
    const env = ctx.db.getEnvelopeById(resolved);
    if (!env) {
      rpcError(RPC_ERRORS.NOT_FOUND, "Envelope not found");
    }

    let fromAddress: ReturnType<typeof parseAddress>;
    try {
      fromAddress = parseAddress(env.from);
    } catch {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Envelope is not a channel message");
    }
    if (fromAddress.type !== "channel") {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Envelope is not a channel message");
    }

    const md = env.metadata;
    if (!md || typeof md !== "object") {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Envelope is missing channel metadata");
    }
    const raw = (md as Record<string, unknown>).channelMessageId;
    if (typeof raw !== "string" || !raw.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Envelope is missing channel-message-id");
    }

    const messageId =
      fromAddress.adapter === "telegram" ? formatTelegramMessageIdCompact(raw.trim()) : raw.trim();

    const binding = ctx.db.getAgentBindingByType(agent.name, fromAddress.adapter);
    if (!binding) {
      rpcError(
        RPC_ERRORS.UNAUTHORIZED,
        `Agent '${agent.name}' is not bound to adapter '${fromAddress.adapter}'`
      );
    }

    const adapter = ctx.adapters.get(binding.adapterToken);
    if (!adapter) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, `Adapter not loaded: ${fromAddress.adapter}`);
    }
    if (!adapter.setReaction) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, `Adapter '${fromAddress.adapter}' does not support reactions`);
    }

    await adapter.setReaction(fromAddress.chatId, messageId, p.emoji.trim());
    return { success: true };
  };

  return {
    "reaction.set": createReactionSet("reaction.set"),
  };
}
