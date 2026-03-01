import { parseDateTimeInputToUnixMsInTimeZone } from "../../shared/time.js";
import { RPC_ERRORS, type TeamSendParams } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { rpcError } from "./context.js";
import { resolveEnvelopeIdInput } from "./resolve-envelope-id.js";

export function validateTeamSendParams(ctx: DaemonContext, params: TeamSendParams): void {
  if (params.interruptNow !== undefined && typeof params.interruptNow !== "boolean") {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid interrupt-now");
  }

  if (params.interruptNow === true && params.deliverAt !== undefined) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "interrupt-now cannot be used with deliver-at");
  }

  if (params.origin !== undefined && params.origin !== "cli" && params.origin !== "internal") {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid origin");
  }

  if (params.replyToEnvelopeId !== undefined) {
    if (typeof params.replyToEnvelopeId !== "string" || !params.replyToEnvelopeId.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid reply-to-envelope-id");
    }
    resolveEnvelopeIdInput(ctx.db, params.replyToEnvelopeId.trim());
  }

  if (params.deliverAt !== undefined) {
    if (typeof params.deliverAt !== "string" || !params.deliverAt.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid deliver-at");
    }
    try {
      parseDateTimeInputToUnixMsInTimeZone(params.deliverAt, ctx.db.getBossTimezone());
    } catch (err) {
      rpcError(
        RPC_ERRORS.INVALID_PARAMS,
        err instanceof Error ? err.message : "Invalid deliver-at"
      );
    }
  }
}
