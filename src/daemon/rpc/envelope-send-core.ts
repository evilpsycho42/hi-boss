import type { Agent } from "../../agent/types.js";
import { formatAgentAddress, parseAddress } from "../../adapters/types.js";
import type { EnvelopeOrigin } from "../../envelope/types.js";
import { DEFAULT_ID_PREFIX_LEN, isHexLower, normalizeIdPrefixInput } from "../../shared/id-format.js";
import { parseDateTimeInputToUnixMsInTimeZone } from "../../shared/time.js";
import type { EnvelopeSendParams } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { rpcError } from "./context.js";
import { resolveEnvelopeIdInput } from "./resolve-envelope-id.js";

export interface EnvelopeSendCoreInput {
  to: string;
  text?: string;
  attachments?: EnvelopeSendParams["attachments"];
  deliverAt?: string;
  interruptNow?: boolean;
  parseMode?: EnvelopeSendParams["parseMode"];
  replyToEnvelopeId?: string;
  toSessionId?: string;
  toProviderSessionId?: string;
  toProvider?: EnvelopeSendParams["toProvider"];
  origin?: EnvelopeOrigin;
}

export interface EnvelopeSendCoreResult {
  id: string;
  interruptedWork?: boolean;
  priorityApplied?: boolean;
}

function resolveTargetSessionIdForSend(params: {
  ctx: DaemonContext;
  toSessionId: EnvelopeSendCoreInput["toSessionId"];
  toProviderSessionId: EnvelopeSendCoreInput["toProviderSessionId"];
  toProvider: EnvelopeSendCoreInput["toProvider"];
  destination: ReturnType<typeof parseAddress>;
  destinationAgentName?: string;
}): string | undefined {
  const hasToSessionId = params.toSessionId !== undefined;
  const hasToProviderSessionId = params.toProviderSessionId !== undefined;
  const hasToProvider = params.toProvider !== undefined;

  if (!hasToSessionId && !hasToProviderSessionId && !hasToProvider) {
    return undefined;
  }

  if (params.destination.type !== "agent") {
    rpcError(
      RPC_ERRORS.INVALID_PARAMS,
      "Session targeting is only supported for agent destinations"
    );
  }

  if (!params.destinationAgentName) {
    rpcError(RPC_ERRORS.INTERNAL_ERROR, "Missing destination agent context");
  }

  if (hasToSessionId && hasToProviderSessionId) {
    rpcError(
      RPC_ERRORS.INVALID_PARAMS,
      "Provide only one of: to-session-id, to-provider-session-id"
    );
  }

  if (!hasToSessionId && !hasToProviderSessionId && hasToProvider) {
    rpcError(
      RPC_ERRORS.INVALID_PARAMS,
      "to-provider can only be used with to-provider-session-id"
    );
  }

  if (hasToSessionId) {
    if (typeof params.toSessionId !== "string" || !params.toSessionId.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid to-session-id");
    }

    const raw = params.toSessionId.trim();
    const direct = params.ctx.db.getAgentSessionById(raw);
    if (direct && direct.agentName === params.destinationAgentName) {
      return direct.id;
    }

    const compactPrefix = normalizeIdPrefixInput(raw);
    if (compactPrefix.length < DEFAULT_ID_PREFIX_LEN || !isHexLower(compactPrefix)) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid to-session-id");
    }

    const matches = params.ctx.db.findAgentSessionsByIdPrefix(
      params.destinationAgentName,
      compactPrefix,
      20
    );
    if (matches.length === 1) {
      return matches[0]!.id;
    }
    if (matches.length === 0) {
      rpcError(RPC_ERRORS.NOT_FOUND, "Session not found");
    }

    rpcError(
      RPC_ERRORS.INVALID_PARAMS,
      "Ambiguous to-session-id (matches multiple sessions)"
    );
  }

  if (typeof params.toProviderSessionId !== "string" || !params.toProviderSessionId.trim()) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid to-provider-session-id");
  }

  let provider: "claude" | "codex" | undefined;
  if (params.toProvider !== undefined) {
    if (params.toProvider !== "claude" && params.toProvider !== "codex") {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid to-provider (expected claude or codex)");
    }
    provider = params.toProvider;
  }

  const byProviderSession = params.ctx.db.findAgentSessionByProviderSessionId({
    agentName: params.destinationAgentName,
    providerSessionId: params.toProviderSessionId.trim(),
    provider,
  });
  if (!byProviderSession) {
    rpcError(RPC_ERRORS.NOT_FOUND, "Session not found");
  }

  return byProviderSession.id;
}

export async function sendEnvelopeFromAgent(params: {
  ctx: DaemonContext;
  senderAgent: Agent;
  input: EnvelopeSendCoreInput;
  interruptReason?: string;
}): Promise<EnvelopeSendCoreResult> {
  const p = params.input;
  if (typeof p.to !== "string" || !p.to.trim()) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid to");
  }

  const toInput = p.to.trim();
  let destination: ReturnType<typeof parseAddress>;
  try {
    destination = parseAddress(toInput);
  } catch (err) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, err instanceof Error ? err.message : "Invalid to");
  }

  params.ctx.db.updateAgentLastSeen(params.senderAgent.name);
  const from = formatAgentAddress(params.senderAgent.name);
  let interruptNow = false;
  const metadata: Record<string, unknown> = {};
  let origin: EnvelopeOrigin = "cli";

  if (p.interruptNow !== undefined) {
    if (typeof p.interruptNow !== "boolean") {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid interrupt-now");
    }
    interruptNow = p.interruptNow;
  }

  if (p.origin !== undefined) {
    if (p.origin !== "cli" && p.origin !== "internal") {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid origin");
    }
    origin = p.origin;
  }
  metadata.origin = origin;

  let destinationAgentName: string | undefined;
  const to = (() => {
    if (destination.type !== "agent") return toInput;

    const destAgent = params.ctx.db.getAgentByNameCaseInsensitive(destination.agentName);
    if (!destAgent) {
      rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
    }
    destinationAgentName = destAgent.name;
    return formatAgentAddress(destAgent.name);
  })();

  if (interruptNow && p.deliverAt !== undefined) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "interrupt-now cannot be used with deliver-at");
  }

  if (interruptNow && destination.type !== "agent") {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "interrupt-now is only supported for agent destinations");
  }

  if (destination.type === "channel") {
    const binding = params.ctx.db.getAgentBindingByType(params.senderAgent.name, destination.adapter);
    if (!binding) {
      rpcError(
        RPC_ERRORS.UNAUTHORIZED,
        `Agent '${params.senderAgent.name}' is not bound to adapter '${destination.adapter}'`
      );
    }
  }

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

  if (p.replyToEnvelopeId !== undefined) {
    if (typeof p.replyToEnvelopeId !== "string" || !p.replyToEnvelopeId.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid reply-to-envelope-id");
    }
    metadata.replyToEnvelopeId = resolveEnvelopeIdInput(params.ctx.db, p.replyToEnvelopeId.trim());
  }

  const targetSessionId = resolveTargetSessionIdForSend({
    ctx: params.ctx,
    toSessionId: p.toSessionId,
    toProviderSessionId: p.toProviderSessionId,
    toProvider: p.toProvider,
    destination,
    destinationAgentName,
  });
  if (targetSessionId) {
    metadata.targetSessionId = targetSessionId;
  }

  let deliverAt: number | undefined;
  if (p.deliverAt) {
    try {
      deliverAt = parseDateTimeInputToUnixMsInTimeZone(p.deliverAt, params.ctx.db.getBossTimezone());
    } catch (err) {
      rpcError(
        RPC_ERRORS.INVALID_PARAMS,
        err instanceof Error ? err.message : "Invalid deliver-at"
      );
    }
  }

  const finalMetadata = Object.keys(metadata).length > 0 ? metadata : undefined;
  let interruptedWork = false;

  if (interruptNow && destination.type === "agent") {
    const targetAgent = params.ctx.db.getAgentByNameCaseInsensitive(destination.agentName);
    if (!targetAgent) {
      rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
    }
    interruptedWork = params.ctx.executor.abortCurrentRun(
      targetAgent.name,
      params.interruptReason ?? "rpc:envelope.send:interrupt-now"
    );
  }

  try {
    const envelope = await params.ctx.router.routeEnvelope({
      from,
      to,
      fromBoss: false,
      content: {
        text: p.text,
        attachments: p.attachments,
      },
      priority: interruptNow ? 1 : 0,
      deliverAt,
      metadata: finalMetadata,
    });

    params.ctx.scheduler.onEnvelopeCreated(envelope);
    if (interruptNow) {
      return {
        id: envelope.id,
        interruptedWork,
        priorityApplied: true,
      };
    }
    return { id: envelope.id };
  } catch (err) {
    const e = err as Error & { data?: unknown };
    if (e.data && typeof e.data === "object") {
      const id = (e.data as Record<string, unknown>).envelopeId;
      if (typeof id === "string" && id.trim()) {
        const env = params.ctx.db.getEnvelopeById(id.trim());
        if (env) {
          params.ctx.scheduler.onEnvelopeCreated(env);
        }
      }
    }
    throw err;
  }
}
