import type { Agent } from "../../agent/types.js";
import { formatAgentAddress, parseAddress } from "../../adapters/types.js";
import type { EnvelopeOrigin } from "../../envelope/types.js";
import { createNewAgentChatId, computeTeamChatId } from "../../shared/chat-scope.js";
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
  origin?: EnvelopeOrigin;
  chatScope?: string;
}

export interface EnvelopeSendCoreSingleResult {
  id: string;
  interruptedWork?: boolean;
  priorityApplied?: boolean;
}

export interface EnvelopeSendCoreBroadcastResult {
  ids: string[];
  noRecipients?: boolean;
}

export type EnvelopeSendCoreResult =
  | EnvelopeSendCoreSingleResult
  | EnvelopeSendCoreBroadcastResult;

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
  let destinationAgentName: string | undefined;
  let to = toInput;
  let deliverAt: number | undefined;
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

  if (interruptNow && p.deliverAt !== undefined) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "interrupt-now cannot be used with deliver-at");
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

  if (destination.type === "team") {
    if (interruptNow) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "interrupt-now is not supported for team broadcast");
    }

    const team = params.ctx.db.getTeamByNameCaseInsensitive(destination.teamName);
    if (!team) {
      rpcError(RPC_ERRORS.NOT_FOUND, "Team not found");
    }
    if (team.status !== "active") {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Cannot send to archived team");
    }

    const recipients = Array.from(
      new Set(
        params.ctx.db
          .listTeamMemberAgentNames(team.name)
          .filter((name) => name !== params.senderAgent.name),
      ),
    );

    if (recipients.length === 0) {
      return { ids: [], noRecipients: true };
    }

    const ids: string[] = [];
    for (const recipient of recipients) {
      try {
        const sent = await sendEnvelopeFromAgent({
          ctx: params.ctx,
          senderAgent: params.senderAgent,
          input: {
            ...p,
            to: formatAgentAddress(recipient),
            chatScope: computeTeamChatId(team.name),
          },
          interruptReason: params.interruptReason,
        });
        if (!("id" in sent)) {
          rpcError(RPC_ERRORS.INTERNAL_ERROR, "Unexpected team broadcast result");
        }
        ids.push(sent.id);
      } catch (err) {
        if (ids.length === 0) {
          throw err;
        }
        const e = err as Error & { code?: number; data?: unknown };
        const originalData =
          e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {};
        rpcError(
          typeof e.code === "number" ? e.code : RPC_ERRORS.DELIVERY_FAILED,
          e.message || "Team broadcast delivery failed",
          {
            ...originalData,
            partialDelivery: true,
            deliveredCount: ids.length,
            totalRecipients: recipients.length,
            failedAgentName: recipient,
            ids,
          }
        );
      }
    }
    return { ids };
  }

  if (
    destination.type === "agent" ||
    destination.type === "agent-new-chat" ||
    destination.type === "agent-chat"
  ) {
    const destAgent = params.ctx.db.getAgentByNameCaseInsensitive(destination.agentName);
    if (!destAgent) {
      rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
    }
    destinationAgentName = destAgent.name;
    to = formatAgentAddress(destAgent.name);
    if (typeof p.chatScope === "string" && p.chatScope.trim().length > 0) {
      metadata.chatScope = p.chatScope.trim();
    } else if (destination.type === "agent-new-chat") {
      metadata.chatScope = createNewAgentChatId();
    } else if (destination.type === "agent-chat") {
      metadata.chatScope = destination.chatId;
    } else {
      rpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "Invalid to (agent destinations must use agent:<name>:new or agent:<name>:<chat-id>)"
      );
    }
  }

  if (destination.type === "team-mention") {
    const team = params.ctx.db.getTeamByNameCaseInsensitive(destination.teamName);
    if (!team) {
      rpcError(RPC_ERRORS.NOT_FOUND, "Team not found");
    }
    if (team.status !== "active") {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Cannot send to archived team");
    }

    const members = params.ctx.db.listTeamMemberAgentNames(team.name);
    const mentioned = members.find(
      (agentName) => agentName.toLowerCase() === destination.agentName.toLowerCase()
    );
    if (!mentioned) {
      rpcError(RPC_ERRORS.NOT_FOUND, "Team member not found");
    }
    destinationAgentName = mentioned;
    to = formatAgentAddress(mentioned);
    metadata.chatScope = p.chatScope ?? computeTeamChatId(team.name);
  }

  if (
    interruptNow &&
    destination.type !== "agent" &&
    destination.type !== "agent-new-chat" &&
    destination.type !== "agent-chat" &&
    destination.type !== "team-mention"
  ) {
    rpcError(
      RPC_ERRORS.INVALID_PARAMS,
      "interrupt-now is only supported for single agent destinations"
    );
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

  const finalMetadata = Object.keys(metadata).length > 0 ? metadata : undefined;
  let interruptedWork = false;

  if (interruptNow) {
    if (!destinationAgentName) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, "Missing destination agent context");
    }
    interruptedWork = params.ctx.executor.abortCurrentRun(
      destinationAgentName,
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
