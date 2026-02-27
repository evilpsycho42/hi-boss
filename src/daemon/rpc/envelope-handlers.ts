/**
 * Envelope and message RPC handlers.
 */

import type {
  RpcMethodRegistry,
  EnvelopeSendParams,
  EnvelopeListParams,
  EnvelopeThreadParams,
  EnvelopeThreadResult,
} from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import { formatAgentAddress, parseAddress } from "../../adapters/types.js";
import { parseDateTimeInputToUnixMsInTimeZone } from "../../shared/time.js";
import { resolveEnvelopeIdInput } from "./resolve-envelope-id.js";
import type { Envelope } from "../../envelope/types.js";
import { sendEnvelopeFromAgent } from "./envelope-send-core.js";

function parseEnvelopeListTimeBoundary(params: {
  raw: unknown;
  flag: "created-after" | "created-before";
  bossTimezone: string;
}): number | undefined {
  const raw = params.raw;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, `Invalid ${params.flag}`);
  }
  try {
    return parseDateTimeInputToUnixMsInTimeZone(raw, params.bossTimezone);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = rawMessage.replace(/^Invalid deliver-at:/, `Invalid ${params.flag}:`);
    rpcError(RPC_ERRORS.INVALID_PARAMS, message);
  }
}

/**
 * Create envelope RPC handlers.
 */
export function createEnvelopeHandlers(ctx: DaemonContext): RpcMethodRegistry {
  const createEnvelopeSend = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as EnvelopeSendParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    if (principal.kind === "admin") {
      rpcError(
        RPC_ERRORS.UNAUTHORIZED,
        "Admin tokens cannot send envelopes (use an agent token or send via a channel adapter)"
      );
    }

    if (p.from !== undefined || p.fromBoss !== undefined || p.fromName !== undefined) {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
    }

    return sendEnvelopeFromAgent({
      ctx,
      senderAgent: principal.agent,
      input: {
        to: p.to,
        text: p.text,
        attachments: p.attachments,
        deliverAt: p.deliverAt,
        interruptNow: p.interruptNow,
        parseMode: p.parseMode,
        replyToEnvelopeId: p.replyToEnvelopeId,
        toSessionId: p.toSessionId,
        toProviderSessionId: p.toProviderSessionId,
        toProvider: p.toProvider,
        origin: p.origin,
      },
    });
  };

  const createEnvelopeList = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as EnvelopeListParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    const legacyAddress = (params as Record<string, unknown>).address;
    if (legacyAddress !== undefined) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "address is no longer supported");
    }

    if (principal.kind !== "agent") {
      rpcError(
        RPC_ERRORS.UNAUTHORIZED,
        "Admin tokens cannot list envelopes (use an agent token)"
      );
    }

    ctx.db.updateAgentLastSeen(principal.agent.name);
    const agentAddress = formatAgentAddress(principal.agent.name);

    const rawTo = typeof p.to === "string" ? p.to.trim() : "";
    const rawFrom = typeof p.from === "string" ? p.from.trim() : "";
    if ((rawTo && rawFrom) || (!rawTo && !rawFrom)) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Provide exactly one of: to, from");
    }

    if (p.status !== "pending" && p.status !== "done") {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid status (expected pending or done)");
    }

    let otherAddress: string;
    try {
      otherAddress = rawTo || rawFrom;
      parseAddress(otherAddress);
    } catch (err) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, err instanceof Error ? err.message : "Invalid address");
    }

    const limit = (() => {
      const v = p.limit;
      if (v === undefined || v === null) return 10;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit");
      }
      const n = Math.trunc(v);
      if (n <= 0) rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit (must be >= 1)");
      if (n > 50) rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit (max 50)");
      return n;
    })();

    const bossTimezone = ctx.db.getBossTimezone();
    const createdAfter = parseEnvelopeListTimeBoundary({
      raw: p.createdAfter,
      flag: "created-after",
      bossTimezone,
    });
    const createdBefore = parseEnvelopeListTimeBoundary({
      raw: p.createdBefore,
      flag: "created-before",
      bossTimezone,
    });
    if (
      typeof createdAfter === "number" &&
      typeof createdBefore === "number" &&
      createdAfter > createdBefore
    ) {
      rpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "Invalid created range (expected created-after <= created-before)"
      );
    }

    const isIncoming = Boolean(rawFrom);
    const shouldAckIncomingPending = isIncoming && p.status === "pending";

    const from = isIncoming ? otherAddress : agentAddress;
    const to = isIncoming ? agentAddress : otherAddress;

    const envelopes = ctx.db.listEnvelopesByRoute({
      from,
      to,
      status: p.status,
      limit,
      dueOnly: shouldAckIncomingPending,
      createdAfter,
      createdBefore,
    });

    if (shouldAckIncomingPending && envelopes.length > 0) {
      const ids = envelopes.map((e) => e.id);
      ctx.db.markEnvelopesDone(ids, {
        reason: "envelope-list-read-ack",
        origin: "internal",
        outcome: "acked-by-list",
      });
      for (const env of envelopes) {
        env.status = "done";
      }
    }

    return { envelopes };
  };

  const createEnvelopeThread = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as EnvelopeThreadParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    if (principal.kind !== "agent") {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
    }

    if (typeof p.envelopeId !== "string" || !p.envelopeId.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid envelope-id");
    }

    ctx.db.updateAgentLastSeen(principal.agent.name);
    const resolvedId = resolveEnvelopeIdInput(ctx.db, p.envelopeId.trim());

    const maxDepth = 20;
    const chain: Envelope[] = [];
    const seen = new Set<string>();

    let currentId: string | null = resolvedId;
    let safety = 0;
    while (currentId && safety < 5000) {
      if (seen.has(currentId)) break;
      seen.add(currentId);

      const env = ctx.db.getEnvelopeById(currentId);
      if (!env) break;
      chain.push(env);

      const md = env.metadata;
      const parentRaw =
        md && typeof md === "object" ? (md as Record<string, unknown>).replyToEnvelopeId : undefined;
      const parentId = typeof parentRaw === "string" ? parentRaw.trim() : "";
      if (!parentId) break;
      currentId = parentId;
      safety++;
    }

    const totalCount = chain.length;
    const truncated = totalCount > maxDepth;
    const envelopes = truncated
      ? [...chain.slice(0, maxDepth - 1), chain[totalCount - 1]!]
      : chain;
    const truncatedIntermediateCount = truncated ? totalCount - maxDepth : 0;

    const result: EnvelopeThreadResult = {
      maxDepth,
      totalCount,
      returnedCount: envelopes.length,
      truncated,
      truncatedIntermediateCount,
      envelopes,
    };
    return result;
  };

  return {
    // Envelope methods (canonical)
    "envelope.send": createEnvelopeSend("envelope.send"),
    "envelope.list": createEnvelopeList("envelope.list"),
    "envelope.thread": createEnvelopeThread("envelope.thread"),
  };
}
