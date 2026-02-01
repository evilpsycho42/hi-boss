/**
 * Setup and boss verification RPC handlers.
 */

import type { RpcMethodRegistry, SetupExecuteParams, BossVerifyParams } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { rpcError } from "./context.js";
import { isValidAgentName, AGENT_NAME_ERROR_MESSAGE } from "../../shared/validation.js";
import { parseDailyResetAt, parseDurationToMs } from "../../shared/session-policy.js";
import { setupAgentHome } from "../../agent/home-setup.js";

/**
 * Create setup RPC handlers.
 */
export function createSetupHandlers(ctx: DaemonContext): RpcMethodRegistry {
  return {
    "setup.check": async () => {
      return { completed: ctx.db.isSetupComplete() };
    },

    "setup.execute": async (params) => {
      const p = params as unknown as SetupExecuteParams;

      // Check if setup is already complete
      if (ctx.db.isSetupComplete()) {
        rpcError(RPC_ERRORS.ALREADY_EXISTS, "Setup already completed");
      }

      if (typeof p.bossName !== "string" || !p.bossName.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid boss-name");
      }

      if (typeof p.agent.name !== "string" || !isValidAgentName(p.agent.name)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, AGENT_NAME_ERROR_MESSAGE);
      }

      if (p.agent.reasoningEffort !== undefined) {
        if (
          p.agent.reasoningEffort !== null &&
          p.agent.reasoningEffort !== "none" &&
          p.agent.reasoningEffort !== "low" &&
          p.agent.reasoningEffort !== "medium" &&
          p.agent.reasoningEffort !== "high" &&
          p.agent.reasoningEffort !== "xhigh"
        ) {
          rpcError(
            RPC_ERRORS.INVALID_PARAMS,
            "Invalid reasoning-effort (expected none, low, medium, high, xhigh)"
          );
        }
      }

      if (p.agent.autoLevel !== "medium" && p.agent.autoLevel !== "high") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid auto-level (expected medium, high)");
      }

      if (p.agent.permissionLevel !== undefined) {
        if (
          p.agent.permissionLevel !== "restricted" &&
          p.agent.permissionLevel !== "standard" &&
          p.agent.permissionLevel !== "privileged"
        ) {
          rpcError(
            RPC_ERRORS.INVALID_PARAMS,
            "Invalid permission-level (expected restricted, standard, privileged)"
          );
        }
      }

      if (p.agent.sessionPolicy !== undefined) {
        if (typeof p.agent.sessionPolicy !== "object" || p.agent.sessionPolicy === null) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy (expected object)");
        }

        const sp = p.agent.sessionPolicy as Record<string, unknown>;
        if (sp.dailyResetAt !== undefined) {
          if (typeof sp.dailyResetAt !== "string") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.daily-reset-at");
          }
          sp.dailyResetAt = parseDailyResetAt(sp.dailyResetAt).normalized;
        }
        if (sp.idleTimeout !== undefined) {
          if (typeof sp.idleTimeout !== "string") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.idle-timeout");
          }
          parseDurationToMs(sp.idleTimeout);
          sp.idleTimeout = sp.idleTimeout.trim();
        }
        if (sp.maxTokens !== undefined) {
          if (typeof sp.maxTokens !== "number" || !Number.isFinite(sp.maxTokens)) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.max-tokens");
          }
          if (sp.maxTokens <= 0) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.max-tokens (must be > 0)");
          }
          sp.maxTokens = Math.trunc(sp.maxTokens);
        }
      }

      if (p.agent.metadata !== undefined) {
        if (typeof p.agent.metadata !== "object" || p.agent.metadata === null || Array.isArray(p.agent.metadata)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid metadata (expected object)");
        }
      }

      if (p.adapter.adapterType !== "telegram") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid adapter-type (expected telegram)");
      }
      if (typeof p.adapter.adapterToken !== "string" || !p.adapter.adapterToken.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid adapter-token");
      }
      if (typeof p.adapter.adapterBossId !== "string" || !p.adapter.adapterBossId.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid adapter-boss-id");
      }

      if (typeof p.bossToken !== "string" || p.bossToken.trim().length < 4) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid boss-token (must be at least 4 characters)");
      }

      if (p.memory !== undefined) {
        if (typeof p.memory !== "object" || p.memory === null) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid memory config");
        }
        const m = p.memory as Record<string, unknown>;
        if (typeof m.enabled !== "boolean") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid memory config enabled");
        }
        if (m.mode !== "default" && m.mode !== "local") {
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
        if (m.enabled === true && (!m.modelPath.trim() || m.dims <= 0)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid memory config (missing modelPath or dims)");
        }
      }

      // Setup agent home directories
      await setupAgentHome(p.agent.name, ctx.config.dataDir);

      // If an adapter is provided and the daemon is running, create/start it first.
      // This validates adapter credentials and avoids committing setup state if startup fails.
      const adapterToken = p.adapter.adapterToken.trim();
      const adapterType = p.adapter.adapterType.trim();
      const hadAdapterAlready = ctx.adapters.has(adapterToken);
      let createdAdapterForSetup = false;

      if (ctx.running) {
        try {
          const adapter = await ctx.createAdapterForBinding(adapterType, adapterToken);
          if (!adapter) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, `Unknown adapter type: ${adapterType}`);
          }
          createdAdapterForSetup = !hadAdapterAlready;
        } catch (err) {
          // Clean up any partially-created adapter on failure.
          if (!hadAdapterAlready) {
            await ctx.removeAdapter(adapterToken).catch(() => undefined);
          }
          throw err;
        }
      }

      let result: { agent: { name: string; createdAt: string }; token: string };
      try {
        result = ctx.db.runInTransaction(() => {
          // Set boss name
          ctx.db.setBossName(p.bossName);

          // Set default provider
          ctx.db.setDefaultProvider(p.provider);

          // Store semantic memory configuration (best-effort; can be disabled)
          const memory = p.memory ?? {
            enabled: false,
            mode: "default" as const,
            modelPath: "",
            modelUri: "",
            dims: 0,
            lastError: "Memory model is not configured",
          };
          ctx.writeMemoryConfigToDb(memory);

          // Create the first agent
          const agentResult = ctx.db.registerAgent({
            name: p.agent.name,
            description: p.agent.description,
            workspace: p.agent.workspace,
            provider: p.provider,
            model: p.agent.model,
            reasoningEffort: p.agent.reasoningEffort,
            autoLevel: p.agent.autoLevel,
            permissionLevel: p.agent.permissionLevel,
            sessionPolicy: p.agent.sessionPolicy,
            metadata: p.agent.metadata,
          });

          // Create adapter binding if provided
          ctx.db.createBinding(p.agent.name, p.adapter.adapterType, p.adapter.adapterToken);

          // Store boss ID for this adapter
          ctx.db.setAdapterBossId(p.adapter.adapterType, p.adapter.adapterBossId.trim().replace(/^@/, ""));

          // Set boss token
          ctx.db.setBossToken(p.bossToken.trim());

          // Mark setup as complete
          ctx.db.markSetupComplete();

          return agentResult;
        });
      } catch (err) {
        // Roll back any adapter started during setup if DB commit fails.
        if (createdAdapterForSetup && adapterToken) {
          await ctx.removeAdapter(adapterToken).catch(() => undefined);
        }
        throw err;
      }

      // Register agent handler for auto-execution
      ctx.registerAgentHandler(p.agent.name);

      return { agentToken: result.token };
    },

    // Boss methods
    "boss.verify": async (params) => {
      const p = params as unknown as BossVerifyParams;
      return { valid: ctx.db.verifyBossToken(p.token) };
    },
  };
}
