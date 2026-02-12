/**
 * Cron schedule RPC handlers.
 */

import type {
  RpcMethodRegistry,
  CronCreateParams,
  CronListParams,
  CronEnableParams,
  CronDisableParams,
  CronDeleteParams,
} from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import { formatAgentAddress, parseAddress } from "../../adapters/types.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";
import { isValidIanaTimeZone } from "../../shared/timezone.js";
import {
  DEFAULT_ID_PREFIX_LEN,
  compactUuid,
  computeUniqueCompactPrefixLength,
  isHexLower,
  normalizeIdPrefixInput,
} from "../../shared/id-format.js";

const MAX_AMBIGUOUS_ID_CANDIDATES = 20;

function assertValidIdPrefix(prefix: string): void {
  if (prefix.length < DEFAULT_ID_PREFIX_LEN) {
    rpcError(
      RPC_ERRORS.INVALID_PARAMS,
      `Invalid id (expected at least ${DEFAULT_ID_PREFIX_LEN} hex chars)`
    );
  }
  if (!isHexLower(prefix)) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid id (expected hex UUID prefix)");
  }
}

function buildAmbiguousCronIdPrefixData(params: {
  idPrefix: string;
  schedules: Array<{
    id: string;
    cron: string;
    to: string;
    enabled: boolean;
    nextDeliverAt?: number;
  }>;
}): Record<string, unknown> {
  const compactIds = params.schedules.map((s) => compactUuid(s.id));
  const prefixLen = computeUniqueCompactPrefixLength(
    compactIds,
    Math.max(DEFAULT_ID_PREFIX_LEN, params.idPrefix.length)
  );

  const truncated = params.schedules.length > MAX_AMBIGUOUS_ID_CANDIDATES;
  const shown = params.schedules.slice(0, MAX_AMBIGUOUS_ID_CANDIDATES).map((s) => ({
    candidateId: compactUuid(s.id).slice(0, prefixLen),
    candidateKind: "cron",
    cron: s.cron,
    to: s.to,
    enabled: s.enabled,
    nextDeliverAt: s.nextDeliverAt ?? null,
  }));

  return {
    kind: "ambiguous-id-prefix",
    idPrefix: params.idPrefix,
    matchCount: params.schedules.length,
    candidatesTruncated: truncated,
    candidatesShown: shown.length,
    candidates: shown,
  };
}

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

    const startedAtMs = Date.now();

    if (typeof p.cron !== "string" || !p.cron.trim()) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid cron");
    }

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

    const to = (() => {
      if (destination.type !== "agent") return toInput;
      const destAgent = ctx.db.getAgentByNameCaseInsensitive(destination.agentName);
      if (!destAgent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }
      return formatAgentAddress(destAgent.name);
    })();

    let timezone: string | undefined;
    if (p.timezone !== undefined) {
      if (typeof p.timezone !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid timezone");
      }
      const trimmed = p.timezone.trim();
      if (!trimmed) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid timezone");
      }
      if (!isValidIanaTimeZone(trimmed)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid timezone (expected IANA timezone)");
      }
      timezone = trimmed;
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
        to,
        content: {
          text: p.text,
          attachments: p.attachments,
        },
        metadata: finalMetadata,
      });
      logEvent("info", "cron-create", {
        "agent-name": agent.name,
        "cron-id": schedule.id,
        state: "success",
        "duration-ms": Date.now() - startedAtMs,
      });
      return { id: schedule.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent("info", "cron-create", {
        "agent-name": agent.name,
        state: "failed",
        "duration-ms": Date.now() - startedAtMs,
        error: errorMessage(err),
      });
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

    const startedAtMs = Date.now();
    const rawId = p.id.trim();

    let resolvedId: string;
    const existing = ctx.db.getCronScheduleById(rawId);
    if (existing) {
      if (existing.agentName !== principal.agent.name) {
        rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
      }
      resolvedId = existing.id;
    } else {
      const idPrefix = normalizeIdPrefixInput(rawId);
      assertValidIdPrefix(idPrefix);
      const matches = ctx.db.findCronSchedulesByAgentIdPrefix(principal.agent.name, idPrefix);
      if (matches.length === 0) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Cron schedule not found");
      }
      if (matches.length > 1) {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          "Ambiguous id prefix",
          buildAmbiguousCronIdPrefixData({ idPrefix, schedules: matches })
        );
      }
      resolvedId = matches[0].id;
    }

    try {
      cron.enableSchedule(principal.agent.name, resolvedId);
      logEvent("info", "cron-enable", {
        "agent-name": principal.agent.name,
        "cron-id": resolvedId,
        state: "success",
        "duration-ms": Date.now() - startedAtMs,
      });
      return { success: true, id: resolvedId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent("info", "cron-enable", {
        "agent-name": principal.agent.name,
        "cron-id": rawId,
        state: "failed",
        "duration-ms": Date.now() - startedAtMs,
        error: errorMessage(err),
      });
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

    const startedAtMs = Date.now();
    const rawId = p.id.trim();

    let resolvedId: string;
    const existing = ctx.db.getCronScheduleById(rawId);
    if (existing) {
      if (existing.agentName !== principal.agent.name) {
        rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
      }
      resolvedId = existing.id;
    } else {
      const idPrefix = normalizeIdPrefixInput(rawId);
      assertValidIdPrefix(idPrefix);
      const matches = ctx.db.findCronSchedulesByAgentIdPrefix(principal.agent.name, idPrefix);
      if (matches.length === 0) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Cron schedule not found");
      }
      if (matches.length > 1) {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          "Ambiguous id prefix",
          buildAmbiguousCronIdPrefixData({ idPrefix, schedules: matches })
        );
      }
      resolvedId = matches[0].id;
    }

    try {
      cron.disableSchedule(principal.agent.name, resolvedId);
      logEvent("info", "cron-disable", {
        "agent-name": principal.agent.name,
        "cron-id": resolvedId,
        state: "success",
        "duration-ms": Date.now() - startedAtMs,
      });
      return { success: true, id: resolvedId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent("info", "cron-disable", {
        "agent-name": principal.agent.name,
        "cron-id": rawId,
        state: "failed",
        "duration-ms": Date.now() - startedAtMs,
        error: errorMessage(err),
      });
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

    const startedAtMs = Date.now();
    const rawId = p.id.trim();

    let resolvedId: string;
    const existing = ctx.db.getCronScheduleById(rawId);
    if (existing) {
      if (existing.agentName !== principal.agent.name) {
        rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
      }
      resolvedId = existing.id;
    } else {
      const idPrefix = normalizeIdPrefixInput(rawId);
      assertValidIdPrefix(idPrefix);
      const matches = ctx.db.findCronSchedulesByAgentIdPrefix(principal.agent.name, idPrefix);
      if (matches.length === 0) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Cron schedule not found");
      }
      if (matches.length > 1) {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          "Ambiguous id prefix",
          buildAmbiguousCronIdPrefixData({ idPrefix, schedules: matches })
        );
      }
      resolvedId = matches[0].id;
    }

    try {
      const deleted = cron.deleteSchedule(principal.agent.name, resolvedId);
      if (!deleted) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Cron schedule not found");
      }
      logEvent("info", "cron-delete", {
        "agent-name": principal.agent.name,
        "cron-id": resolvedId,
        state: "success",
        "duration-ms": Date.now() - startedAtMs,
      });
      return { success: true, id: resolvedId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent("info", "cron-delete", {
        "agent-name": principal.agent.name,
        "cron-id": rawId,
        state: "failed",
        "duration-ms": Date.now() - startedAtMs,
        error: errorMessage(err),
      });
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
    "cron.enable": createCronEnable("cron.enable"),
    "cron.disable": createCronDisable("cron.disable"),
    "cron.delete": createCronDelete("cron.delete"),
  };
}
