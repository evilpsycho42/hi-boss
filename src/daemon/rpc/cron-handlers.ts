/**
 * Cron schedule RPC handlers.
 */

import type {
  RpcMethodRegistry,
  CronCreateParams,
  CronListParams,
  CronGetParams,
  CronEnableParams,
  CronDisableParams,
  CronDeleteParams,
} from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import { parseAddress } from "../../adapters/types.js";

/**
 * Create cron RPC handlers.
 */
export function createCronHandlers(ctx: DaemonContext): RpcMethodRegistry {
  const createCronCreate = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as CronCreateParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    if (principal.kind !== "agent") {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
    }

    if (typeof p.cron !== "string" || !p.cron.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid cron");
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

    const metadata: Record<string, unknown> = {};

    if (p.parseMode !== undefined) {
      if (typeof p.parseMode !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid parse-mode");
      }
      const mode = p.parseMode.trim();
      if (mode !== "plain" && mode !== "markdownv2" && mode !== "html") {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          "Invalid parse-mode (expected plain, markdownv2, or html)"
        );
      }
      if (destination.type !== "channel") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "parse-mode is only supported for channel destinations");
      }
      metadata.parseMode = mode;
    }

    if (p.replyToMessageId !== undefined) {
      if (typeof p.replyToMessageId !== "string" || !p.replyToMessageId.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid reply-to-message-id");
      }
      if (destination.type !== "channel") {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          "reply-to-message-id is only supported for channel destinations"
        );
      }
      metadata.replyToMessageId = p.replyToMessageId.trim();
    }

    // Check binding for channel destinations.
    const agent = principal.agent;
    ctx.db.updateAgentLastSeen(agent.name);
    if (destination.type === "channel") {
      const binding = ctx.db.getAgentBindingByType(agent.name, destination.adapter);
      if (!binding) {
        rpcError(
          RPC_ERRORS.UNAUTHORIZED,
          `Agent '${agent.name}' is not bound to adapter '${destination.adapter}'`
        );
      }
    }

    let timezone: string | undefined;
    if (p.timezone !== undefined) {
      if (typeof p.timezone !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid timezone");
      }
      timezone = p.timezone.trim();
    }

    const finalMetadata = Object.keys(metadata).length > 0 ? metadata : undefined;
    const cron = ctx.cronScheduler;
    if (!cron) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, "Cron scheduler not initialized");
    }

    try {
      const { schedule } = cron.createSchedule({
        agentName: agent.name,
        cron: p.cron.trim(),
        timezone,
        to: p.to.trim(),
        content: {
          text: p.text,
          attachments: p.attachments,
        },
        metadata: finalMetadata,
      });
      return { id: schedule.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not bound to adapter")) {
        rpcError(RPC_ERRORS.UNAUTHORIZED, message);
      }
      rpcError(RPC_ERRORS.INVALID_PARAMS, message);
    }
  };

  const createCronList = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as CronListParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    if (principal.kind !== "agent") {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
    }

    ctx.db.updateAgentLastSeen(principal.agent.name);
    const cron = ctx.cronScheduler;
    if (!cron) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, "Cron scheduler not initialized");
    }

    return { schedules: cron.listSchedules(principal.agent.name) };
  };

  const createCronGet = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as CronGetParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    if (principal.kind !== "agent") {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
    }

    if (typeof p.id !== "string" || !p.id.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid id");
    }

    ctx.db.updateAgentLastSeen(principal.agent.name);
    const cron = ctx.cronScheduler;
    if (!cron) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, "Cron scheduler not initialized");
    }

    try {
      const schedule = cron.getSchedule(principal.agent.name, p.id.trim());
      return { schedule };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Cron schedule not found") {
        rpcError(RPC_ERRORS.NOT_FOUND, message);
      }
      if (message === "Access denied") {
        rpcError(RPC_ERRORS.UNAUTHORIZED, message);
      }
      rpcError(RPC_ERRORS.INTERNAL_ERROR, message);
    }
  };

  const createCronEnable = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as CronEnableParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    if (principal.kind !== "agent") {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
    }

    if (typeof p.id !== "string" || !p.id.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid id");
    }

    ctx.db.updateAgentLastSeen(principal.agent.name);
    const cron = ctx.cronScheduler;
    if (!cron) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, "Cron scheduler not initialized");
    }

    try {
      cron.enableSchedule(principal.agent.name, p.id.trim());
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Cron schedule not found") {
        rpcError(RPC_ERRORS.NOT_FOUND, message);
      }
      if (message === "Access denied") {
        rpcError(RPC_ERRORS.UNAUTHORIZED, message);
      }
      if (message.includes("not bound to adapter")) {
        rpcError(RPC_ERRORS.UNAUTHORIZED, message);
      }
      rpcError(RPC_ERRORS.INVALID_PARAMS, message);
    }
  };

  const createCronDisable = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as CronDisableParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    if (principal.kind !== "agent") {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
    }

    if (typeof p.id !== "string" || !p.id.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid id");
    }

    ctx.db.updateAgentLastSeen(principal.agent.name);
    const cron = ctx.cronScheduler;
    if (!cron) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, "Cron scheduler not initialized");
    }

    try {
      cron.disableSchedule(principal.agent.name, p.id.trim());
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Cron schedule not found") {
        rpcError(RPC_ERRORS.NOT_FOUND, message);
      }
      if (message === "Access denied") {
        rpcError(RPC_ERRORS.UNAUTHORIZED, message);
      }
      rpcError(RPC_ERRORS.INTERNAL_ERROR, message);
    }
  };

  const createCronDelete = (operation: string) => async (params: Record<string, unknown>) => {
    const p = params as unknown as CronDeleteParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed(operation, principal);

    if (principal.kind !== "agent") {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
    }

    if (typeof p.id !== "string" || !p.id.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid id");
    }

    ctx.db.updateAgentLastSeen(principal.agent.name);
    const cron = ctx.cronScheduler;
    if (!cron) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, "Cron scheduler not initialized");
    }

    try {
      const deleted = cron.deleteSchedule(principal.agent.name, p.id.trim());
      if (!deleted) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Cron schedule not found");
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Cron schedule not found") {
        rpcError(RPC_ERRORS.NOT_FOUND, message);
      }
      if (message === "Access denied") {
        rpcError(RPC_ERRORS.UNAUTHORIZED, message);
      }
      rpcError(RPC_ERRORS.INTERNAL_ERROR, message);
    }
  };

  return {
    "cron.create": createCronCreate("cron.create"),
    "cron.list": createCronList("cron.list"),
    "cron.get": createCronGet("cron.get"),
    "cron.enable": createCronEnable("cron.enable"),
    "cron.disable": createCronDisable("cron.disable"),
    "cron.delete": createCronDelete("cron.delete"),
  };
}
