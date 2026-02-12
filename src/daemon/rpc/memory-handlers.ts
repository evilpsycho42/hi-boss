/**
 * Memory RPC handlers.
 */

import type {
  RpcMethodRegistry,
  MemoryAddParams,
  MemoryAddResult,
  MemorySearchParams,
  MemorySearchResult,
  MemoryListParams,
  MemoryListResult,
  MemoryCategoriesParams,
  MemoryCategoriesResult,
  MemoryDeleteCategoryParams,
  MemoryDeleteCategoryResult,
  MemoryGetParams,
  MemoryGetResult,
  MemoryDeleteParams,
  MemoryDeleteResult,
  MemoryClearParams,
  MemoryClearResult,
  MemorySetupParams,
  MemorySetupResult,
} from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext, Principal } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";
import {
  DEFAULT_ID_PREFIX_LEN,
  compactUuid,
  computeUniqueCompactPrefixLength,
  isHexLower,
  normalizeIdPrefixInput,
  truncateForCli,
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

function buildAmbiguousMemoryIdPrefixData(params: {
  idPrefix: string;
  memories: Array<{ id: string; category: string; createdAt: number; text: string }>;
}): Record<string, unknown> {
  const compactIds = params.memories.map((m) => compactUuid(m.id));
  const prefixLen = computeUniqueCompactPrefixLength(
    compactIds,
    Math.max(DEFAULT_ID_PREFIX_LEN, params.idPrefix.length)
  );

  const truncated = params.memories.length > MAX_AMBIGUOUS_ID_CANDIDATES;
  const shown = params.memories.slice(0, MAX_AMBIGUOUS_ID_CANDIDATES).map((m) => ({
    candidateId: compactUuid(m.id).slice(0, prefixLen),
    candidateKind: "memory",
    category: m.category,
    createdAt: m.createdAt,
    textPreview: truncateForCli(m.text),
  }));

  return {
    kind: "ambiguous-id-prefix",
    idPrefix: params.idPrefix,
    matchCount: params.memories.length,
    candidatesTruncated: truncated,
    candidatesShown: shown.length,
    candidates: shown,
  };
}

function requireAgentForMemory(
  ctx: DaemonContext,
  principal: Principal
): string {
  if (principal.kind !== "agent") {
    rpcError(RPC_ERRORS.UNAUTHORIZED, "Boss tokens cannot access agent memory (use an agent token)");
  }
  ctx.db.updateAgentLastSeen(principal.agent.name);
  return principal.agent.name;
}

/**
 * Create memory RPC handlers.
 */
export function createMemoryHandlers(ctx: DaemonContext): RpcMethodRegistry {
  return {
    "memory.add": async (params) => {
      const p = params as unknown as MemoryAddParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("memory.add", principal);

      if (typeof p.text !== "string" || !p.text.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid text");
      }
      if (p.category !== undefined && typeof p.category !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid category");
      }

      const agentName = requireAgentForMemory(ctx, principal);
      const memory = await ctx.ensureMemoryService();
      const startedAtMs = Date.now();
      try {
        const id = await memory.add(agentName, p.text, { category: p.category });
        logEvent("info", "memory-add", {
          "agent-name": agentName,
          "memory-id": id,
          category: p.category ?? "fact",
          state: "success",
          "duration-ms": Date.now() - startedAtMs,
        });
        const result: MemoryAddResult = { id };
        return result;
      } catch (err) {
        logEvent("info", "memory-add", {
          "agent-name": agentName,
          category: p.category ?? "fact",
          state: "failed",
          "duration-ms": Date.now() - startedAtMs,
          error: errorMessage(err),
        });
        throw err;
      }
    },

    "memory.search": async (params) => {
      const p = params as unknown as MemorySearchParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("memory.search", principal);

      if (typeof p.query !== "string" || !p.query.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid query");
      }
      if (p.category !== undefined && typeof p.category !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid category");
      }

      let limit = 5;
      if (p.limit !== undefined) {
        if (typeof p.limit !== "number" || !Number.isFinite(p.limit)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit");
        }
        if (p.limit <= 0) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit (must be > 0)");
        }
        limit = Math.trunc(p.limit);
      }

      const agentName = requireAgentForMemory(ctx, principal);
      const memory = await ctx.ensureMemoryService();
      const memories = await memory.search(agentName, p.query, { category: p.category, limit });
      const result: MemorySearchResult = { memories };
      return result;
    },

    "memory.list": async (params) => {
      const p = params as unknown as MemoryListParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("memory.list", principal);

      if (p.category !== undefined && typeof p.category !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid category");
      }

      let limit = 100;
      if (p.limit !== undefined) {
        if (typeof p.limit !== "number" || !Number.isFinite(p.limit)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit");
        }
        if (p.limit <= 0) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit (must be > 0)");
        }
        limit = Math.trunc(p.limit);
      }

      const agentName = requireAgentForMemory(ctx, principal);
      const memory = await ctx.ensureMemoryStore();
      const memories = await memory.list(agentName, { category: p.category, limit });
      const result: MemoryListResult = { memories };
      return result;
    },

    "memory.categories": async (params) => {
      const p = params as unknown as MemoryCategoriesParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("memory.categories", principal);

      const agentName = requireAgentForMemory(ctx, principal);
      const memory = await ctx.ensureMemoryStore();
      const categories = await memory.categories(agentName);
      const result: MemoryCategoriesResult = { categories };
      return result;
    },

    "memory.delete-category": async (params) => {
      const p = params as unknown as MemoryDeleteCategoryParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("memory.delete-category", principal);

      if (typeof p.category !== "string" || !p.category.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid category");
      }

      const agentName = requireAgentForMemory(ctx, principal);
      const memory = await ctx.ensureMemoryStore();
      const startedAtMs = Date.now();
      try {
        const deleted = await memory.deleteCategory(agentName, p.category);
        logEvent("info", "memory-delete-category", {
          "agent-name": agentName,
          category: p.category,
          "deleted-count": deleted,
          state: "success",
          "duration-ms": Date.now() - startedAtMs,
        });
        const result: MemoryDeleteCategoryResult = { ok: true, deleted };
        return result;
      } catch (err) {
        logEvent("info", "memory-delete-category", {
          "agent-name": agentName,
          category: p.category,
          state: "failed",
          "duration-ms": Date.now() - startedAtMs,
          error: errorMessage(err),
        });
        throw err;
      }
    },

    "memory.get": async (params) => {
      const p = params as unknown as MemoryGetParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("memory.get", principal);

      if (typeof p.id !== "string" || !p.id.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid id");
      }

      const agentName = requireAgentForMemory(ctx, principal);
      const memory = await ctx.ensureMemoryStore();
      const rawId = p.id.trim();
      const exact = await memory.get(agentName, rawId);
      if (exact) {
        const result: MemoryGetResult = { memory: exact };
        return result;
      }

      const idPrefix = normalizeIdPrefixInput(rawId);
      assertValidIdPrefix(idPrefix);
      const matches = await memory.findByIdPrefix(agentName, idPrefix);
      if (matches.length === 0) {
        const result: MemoryGetResult = { memory: null };
        return result;
      }
      if (matches.length > 1) {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          "Ambiguous id prefix",
          buildAmbiguousMemoryIdPrefixData({ idPrefix, memories: matches })
        );
      }

      const result: MemoryGetResult = { memory: matches[0] };
      return result;
    },

    "memory.delete": async (params) => {
      const p = params as unknown as MemoryDeleteParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("memory.delete", principal);

      if (typeof p.id !== "string" || !p.id.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid id");
      }

      const agentName = requireAgentForMemory(ctx, principal);
      const memory = await ctx.ensureMemoryStore();
      const startedAtMs = Date.now();
      const rawId = p.id.trim();
      try {
        let resolvedId: string;
        const exact = await memory.get(agentName, rawId);
        if (exact) {
          resolvedId = exact.id;
        } else {
          const idPrefix = normalizeIdPrefixInput(rawId);
          assertValidIdPrefix(idPrefix);
          const matches = await memory.findByIdPrefix(agentName, idPrefix);
          if (matches.length === 0) {
            rpcError(RPC_ERRORS.NOT_FOUND, "Memory not found");
          }
          if (matches.length > 1) {
            rpcError(
              RPC_ERRORS.INVALID_PARAMS,
              "Ambiguous id prefix",
              buildAmbiguousMemoryIdPrefixData({ idPrefix, memories: matches })
            );
          }
          resolvedId = matches[0].id;
        }

        await memory.delete(agentName, resolvedId);
        logEvent("info", "memory-delete", {
          "agent-name": agentName,
          "memory-id": resolvedId,
          state: "success",
          "duration-ms": Date.now() - startedAtMs,
        });
        const result: MemoryDeleteResult = { ok: true };
        return result;
      } catch (err) {
        logEvent("info", "memory-delete", {
          "agent-name": agentName,
          "memory-id": rawId,
          state: "failed",
          "duration-ms": Date.now() - startedAtMs,
          error: errorMessage(err),
        });
        throw err;
      }
    },

    "memory.clear": async (params) => {
      const p = params as unknown as MemoryClearParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("memory.clear", principal);

      const agentName = requireAgentForMemory(ctx, principal);
      const memory = await ctx.ensureMemoryStore();
      const startedAtMs = Date.now();
      try {
        await memory.clear(agentName);
        logEvent("info", "memory-clear", {
          "agent-name": agentName,
          state: "success",
          "duration-ms": Date.now() - startedAtMs,
        });
        const result: MemoryClearResult = { ok: true };
        return result;
      } catch (err) {
        logEvent("info", "memory-clear", {
          "agent-name": agentName,
          state: "failed",
          "duration-ms": Date.now() - startedAtMs,
          error: errorMessage(err),
        });
        throw err;
      }
    },

    "memory.setup": async (params) => {
      const p = params as unknown as MemorySetupParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("memory.setup", principal);

      const startedAtMs = Date.now();

      if (typeof p.memory !== "object" || p.memory === null) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid memory config");
      }
      const m = p.memory as Record<string, unknown>;

      const enabled = m.enabled === true;
      const mode = m.mode;
      if (mode !== "default" && mode !== "local") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid memory config mode");
      }
      if (typeof m.modelPath !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid memory config modelPath");
      }
      if (typeof m.modelUri !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid memory config modelUri");
      }
      if (typeof m.dims !== "number" || !Number.isFinite(m.dims) || m.dims < 0) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid memory config dims");
      }
      if (typeof m.lastError !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid memory config lastError");
      }

      const next = {
        enabled,
        mode,
        modelPath: m.modelPath,
        modelUri: m.modelUri,
        dims: Math.trunc(m.dims),
        lastError: m.lastError,
      } as const;

      if (next.enabled && (!next.modelPath.trim() || next.dims <= 0)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid memory config (missing modelPath or dims)");
      }

      ctx.writeMemoryConfigToDb(next);
      await ctx.closeMemoryService();
      await ctx.closeMemoryStore();

      if (next.enabled) {
        try {
          await ctx.ensureMemoryService();
        } catch {
          // ensureMemoryService updates config and returns a meaningful error for memory.* calls
        }
      }

      const modelPath = (ctx.db.getConfig("memory_model_path") ?? "").trim();
      const dims = Number(ctx.db.getConfig("memory_model_dims") ?? "0") || 0;
      const lastError = (ctx.db.getConfig("memory_model_last_error") ?? "").trim();
      const memoryEnabled = ctx.db.getConfig("memory_enabled") === "true";

      const result: MemorySetupResult = {
        memoryEnabled,
        modelPath,
        dims,
        lastError,
      };
      logEvent("info", "memory-setup", {
        actor: principal.kind,
        state: result.memoryEnabled ? "success" : "failed",
        "duration-ms": Date.now() - startedAtMs,
        "memory-enabled": result.memoryEnabled,
        dims: result.dims,
        error: result.lastError || undefined,
      });
      return result;
    },
  };
}
