/**
 * Setup and boss verification RPC handlers.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { RpcMethodRegistry, SetupExecuteParams, BossVerifyParams } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { rpcError } from "./context.js";
import { isValidAgentName, AGENT_NAME_ERROR_MESSAGE } from "../../shared/validation.js";
import { parseDailyResetAt, parseDurationToMs } from "../../shared/session-policy.js";
import { setupAgentHome } from "../../agent/home-setup.js";
import { isValidIanaTimeZone, getDaemonIanaTimeZone } from "../../shared/timezone.js";

function ensureBossProfileFile(hibossDir: string): void {
  try {
    const bossMdPath = path.join(hibossDir, "BOSS.md");
    if (!fs.existsSync(bossMdPath)) {
      fs.writeFileSync(bossMdPath, "", "utf8");
      return;
    }
    const stat = fs.statSync(bossMdPath);
    if (!stat.isFile()) {
      // Best-effort; don't fail setup on customization file issues.
      return;
    }
  } catch {
    // Best-effort; don't fail setup on customization file issues.
  }
}

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

      if ((p as any).providerSourceHome !== undefined) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "provider-source-home is no longer supported");
      }

      if (typeof p.bossName !== "string" || !p.bossName.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid boss-name");
      }

      if (typeof p.bossTimezone !== "string" || !p.bossTimezone.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid boss-timezone");
      }
      const bossTimezone = p.bossTimezone.trim();
      if (!isValidIanaTimeZone(bossTimezone)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid boss-timezone (expected IANA timezone)");
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

      if (p.agent.permissionLevel !== undefined) {
        if (
          p.agent.permissionLevel !== "restricted" &&
          p.agent.permissionLevel !== "standard" &&
          p.agent.permissionLevel !== "privileged" &&
          p.agent.permissionLevel !== "boss"
        ) {
          rpcError(
            RPC_ERRORS.INVALID_PARAMS,
            "Invalid permission-level (expected restricted, standard, privileged, boss)"
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
        if ((sp as any).maxTokens !== undefined) {
          rpcError(
            RPC_ERRORS.INVALID_PARAMS,
            "Invalid session-policy.max-tokens (use max-context-length)"
          );
        }
        if (sp.maxContextLength !== undefined) {
          if (typeof sp.maxContextLength !== "number" || !Number.isFinite(sp.maxContextLength)) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.max-context-length");
          }
          if (sp.maxContextLength <= 0) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.max-context-length (must be > 0)");
          }
          (sp as any).maxContextLength = Math.trunc(sp.maxContextLength);
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

      if ((p as any).memory !== undefined) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "memory is no longer supported (use long-term memory files)");
      }

      // Setup agent home directory
      await setupAgentHome(p.agent.name, ctx.config.dataDir);
      ensureBossProfileFile(ctx.config.dataDir);

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

      let createdAgentToken: string;
      try {
        createdAgentToken = ctx.db.runInTransaction(() => {
          // Set boss name
          ctx.db.setBossName(p.bossName);

          // Set boss timezone (used for all displayed timestamps)
          ctx.db.setConfig("boss_timezone", bossTimezone || getDaemonIanaTimeZone());

          // Set default provider
          ctx.db.setDefaultProvider(p.provider);

          // Create the first agent
          const metadata =
            p.agent.metadata && typeof p.agent.metadata === "object" && !Array.isArray(p.agent.metadata)
              ? (() => {
                  const copy = { ...(p.agent.metadata as Record<string, unknown>) };
                  // Reserved internal metadata key (best-effort session resume handle).
                  delete copy.sessionHandle;
                  return copy;
                })()
              : undefined;
          const agentResult = ctx.db.registerAgent({
            name: p.agent.name,
            description: p.agent.description,
            workspace: p.agent.workspace,
            provider: p.provider,
            model: p.agent.model,
            reasoningEffort: p.agent.reasoningEffort,
            permissionLevel: p.agent.permissionLevel,
            sessionPolicy: p.agent.sessionPolicy,
            metadata,
          });

          // Create adapter binding if provided
          ctx.db.createBinding(p.agent.name, p.adapter.adapterType, p.adapter.adapterToken);

          // Store boss ID for this adapter
          ctx.db.setAdapterBossId(p.adapter.adapterType, p.adapter.adapterBossId.trim().replace(/^@/, ""));

          // Set boss token
          ctx.db.setBossToken(p.bossToken.trim());

          // Mark setup as complete
          ctx.db.markSetupComplete();

          return agentResult.token;
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

      return { agentToken: createdAgentToken };
    },

    // Boss methods
    "boss.verify": async (params) => {
      const p = params as unknown as BossVerifyParams;
      return { valid: ctx.db.verifyBossToken(p.token) };
    },
  };
}
