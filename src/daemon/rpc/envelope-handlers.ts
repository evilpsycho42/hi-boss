/**
 * Envelope and message RPC handlers.
 */

import type {
  RpcMethodRegistry,
  EnvelopeSendParams,
  EnvelopeListParams,
  EnvelopeGetParams,
} from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import { formatAgentAddress, parseAddress } from "../../adapters/types.js";
import { parseDateTimeInputToUtcIso } from "../../shared/time.js";
import { DEFAULT_ENVELOPE_LIST_BOX } from "../../shared/defaults.js";

/**
 * Create envelope RPC handlers.
 */
export function createEnvelopeHandlers(ctx: DaemonContext): RpcMethodRegistry {
  const createEnvelopeSend = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as EnvelopeSendParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    if (typeof p.to !== "string" || !p.to.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid to");
    }

    let destination: ReturnType<typeof parseAddress>;
    try {
      destination = parseAddress(p.to);
    } catch (err) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, err instanceof Error ? err.message : "Invalid to");
    }

    let from: string;
    let fromBoss = false;
    const metadata: Record<string, unknown> = {};

    if (principal.kind === "boss") {
      if (typeof p.from !== "string" || !p.from.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Boss token requires from");
      }
      from = p.from.trim();
      fromBoss = p.fromBoss === true;

      if (typeof p.fromName === "string" && p.fromName.trim()) {
        metadata.fromName = p.fromName.trim();
      }
    } else {
      if (p.from !== undefined || p.fromBoss !== undefined || p.fromName !== undefined) {
        rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
      }

      const agent = principal.agent;
      ctx.db.updateAgentLastSeen(agent.name);
      from = formatAgentAddress(agent.name);

      // Check binding for channel destinations (agent sender only)
      if (destination.type === "channel") {
        const binding = ctx.db.getAgentBindingByType(agent.name, destination.adapter);
        if (!binding) {
          rpcError(
            RPC_ERRORS.UNAUTHORIZED,
            `Agent '${agent.name}' is not bound to adapter '${destination.adapter}'`
          );
        }
      }
    }

    // Validate channel delivery requirements: sending to a channel requires from=agent:*
    if (destination.type === "channel") {
      let sender: ReturnType<typeof parseAddress>;
      try {
        sender = parseAddress(from);
      } catch (err) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, err instanceof Error ? err.message : "Invalid from");
      }
      if (sender.type !== "agent") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Channel destinations require from=agent:<name>");
      }

      // Boss token can impersonate senders, but channel delivery still requires a real binding.
      if (principal.kind === "boss") {
        const binding = ctx.db.getAgentBindingByType(sender.agentName, destination.adapter);
        if (!binding) {
          rpcError(
            RPC_ERRORS.INVALID_PARAMS,
            `Sender agent '${sender.agentName}' is not bound to adapter '${destination.adapter}'`
          );
        }
      }
    }

    if (p.parseMode !== undefined) {
      if (typeof p.parseMode !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid parse-mode");
      }
      const mode = p.parseMode.trim();
      if (mode !== "plain" && mode !== "markdownv2" && mode !== "html") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid parse-mode (expected plain, markdownv2, or html)");
      }
      if (destination.type !== "channel") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "parse-mode is only supported for channel destinations");
      }
      metadata.parseMode = mode;
    }

    if (p.replyToMessageId !== undefined) {
      if (typeof p.replyToMessageId !== "string" || !p.replyToMessageId.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid reply-to-channel-message-id");
      }
      if (destination.type !== "channel") {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          "reply-to-channel-message-id is only supported for channel destinations"
        );
      }
      metadata.replyToMessageId = p.replyToMessageId.trim();
    }

    let deliverAt: string | undefined;
    if (p.deliverAt) {
      try {
        deliverAt = parseDateTimeInputToUtcIso(p.deliverAt);
      } catch (err) {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          err instanceof Error ? err.message : "Invalid deliver-at"
        );
      }
    }

    const finalMetadata = Object.keys(metadata).length > 0 ? metadata : undefined;

    try {
      const envelope = await ctx.router.routeEnvelope({
        from,
        to: p.to,
        fromBoss,
        content: {
          text: p.text,
          attachments: p.attachments,
        },
        deliverAt,
        metadata: finalMetadata,
      });

      ctx.scheduler.onEnvelopeCreated(envelope);
      return { id: envelope.id };
    } catch (err) {
      // Best-effort: ensure the scheduler sees newly-created scheduled envelopes, even if immediate delivery failed.
      const e = err as Error & { data?: unknown };
      if (e.data && typeof e.data === "object") {
        const id = (e.data as Record<string, unknown>).envelopeId;
        if (typeof id === "string" && id.trim()) {
          const env = ctx.db.getEnvelopeById(id.trim());
          if (env) {
            ctx.scheduler.onEnvelopeCreated(env);
          }
        }
      }
      throw err;
    }
  };

  const createEnvelopeList = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as EnvelopeListParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    let address: string;
    if (principal.kind === "boss") {
      if (typeof p.address !== "string" || !p.address.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Boss token requires address");
      }
      address = p.address.trim();
      try {
        parseAddress(address);
      } catch (err) {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          err instanceof Error ? err.message : "Invalid address"
        );
      }
    } else {
      if (p.address !== undefined) {
        rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
      }
      ctx.db.updateAgentLastSeen(principal.agent.name);
      address = formatAgentAddress(principal.agent.name);
    }

    const envelopes = ctx.db.listEnvelopes({
      address,
      box: p.box ?? DEFAULT_ENVELOPE_LIST_BOX,
      status: p.status,
      limit: p.limit,
    });

    return { envelopes };
  };

  const createEnvelopeGet = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as EnvelopeGetParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    if (principal.kind === "agent") {
      ctx.db.updateAgentLastSeen(principal.agent.name);
    }

    if (typeof p.id !== "string" || !p.id.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid id");
    }

    const envelope = ctx.db.getEnvelopeById(p.id);
    if (!envelope) {
      rpcError(RPC_ERRORS.NOT_FOUND, "Envelope not found");
    }

    if (principal.kind === "agent") {
      // Verify the agent has access to this envelope
      const agentAddress = formatAgentAddress(principal.agent.name);
      if (envelope.to !== agentAddress && envelope.from !== agentAddress) {
        rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
      }
    }

    return { envelope };
  };

  return {
    // Envelope methods (canonical)
    "envelope.send": createEnvelopeSend("envelope.send"),
    "envelope.list": createEnvelopeList("envelope.list"),
    "envelope.get": createEnvelopeGet("envelope.get"),

    // Message methods (backwards-compatible aliases)
    "message.send": createEnvelopeSend("message.send"),
    "message.list": createEnvelopeList("message.list"),
    "message.get": createEnvelopeGet("message.get"),
  };
}
