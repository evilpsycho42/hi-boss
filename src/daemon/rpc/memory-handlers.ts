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

function requireAgentForMemory(
  ctx: DaemonContext,
  principal: Principal,
  params: Record<string, unknown>
): string {
  const legacyAgentName = params.agentName;
  if (legacyAgentName !== undefined) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "agentName is no longer supported");
  }
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

      const agentName = requireAgentForMemory(ctx, principal, params);
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

      const agentName = requireAgentForMemory(ctx, principal, params);
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

      const agentName = requireAgentForMemory(ctx, principal, params);
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

      const agentName = requireAgentForMemory(ctx, principal, params);
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

      const agentName = requireAgentForMemory(ctx, principal, params);
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

      const agentName = requireAgentForMemory(ctx, principal, params);
      const memory = await ctx.ensureMemoryStore();
      const result: MemoryGetResult = { memory: await memory.get(agentName, p.id) };
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

      const agentName = requireAgentForMemory(ctx, principal, params);
      const memory = await ctx.ensureMemoryStore();
      const startedAtMs = Date.now();
      try {
        await memory.delete(agentName, p.id);
        logEvent("info", "memory-delete", {
          "agent-name": agentName,
          "memory-id": p.id,
          state: "success",
          "duration-ms": Date.now() - startedAtMs,
        });
        const result: MemoryDeleteResult = { ok: true };
        return result;
      } catch (err) {
        logEvent("info", "memory-delete", {
          "agent-name": agentName,
          "memory-id": p.id,
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

      const agentName = requireAgentForMemory(ctx, principal, params);
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
