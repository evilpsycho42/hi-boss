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
import { BACKGROUND_AGENT_NAME } from "../../shared/defaults.js";
import {
  getSpeakerBindingIntegrity,
  toSpeakerBindingIntegrityView,
} from "../../shared/speaker-binding-invariant.js";

function validateSetupAgentName(name: unknown): string {
  if (typeof name !== "string" || !isValidAgentName(name)) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, AGENT_NAME_ERROR_MESSAGE);
  }
  const normalized = name.trim();
  if (normalized.toLowerCase() === BACKGROUND_AGENT_NAME) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, `Reserved agent name: ${BACKGROUND_AGENT_NAME}`);
  }
  return normalized;
}

function validateSetupAgentConfig(
  agent: SetupExecuteParams["speakerAgent"] | SetupExecuteParams["leaderAgent"],
  label: "speaker-agent" | "leader-agent"
): void {
  if (agent.reasoningEffort !== undefined) {
    if (
      agent.reasoningEffort !== null &&
      agent.reasoningEffort !== "none" &&
      agent.reasoningEffort !== "low" &&
      agent.reasoningEffort !== "medium" &&
      agent.reasoningEffort !== "high" &&
      agent.reasoningEffort !== "xhigh"
    ) {
      rpcError(
        RPC_ERRORS.INVALID_PARAMS,
        `Invalid ${label}.reasoning-effort (expected none, low, medium, high, xhigh)`
      );
    }
  }

  if (agent.permissionLevel !== undefined) {
    if (
      agent.permissionLevel !== "restricted" &&
      agent.permissionLevel !== "standard" &&
      agent.permissionLevel !== "privileged" &&
      agent.permissionLevel !== "boss"
    ) {
      rpcError(
        RPC_ERRORS.INVALID_PARAMS,
        `Invalid ${label}.permission-level (expected restricted, standard, privileged, boss)`
      );
    }
  }

  if (agent.sessionPolicy !== undefined) {
    if (typeof agent.sessionPolicy !== "object" || agent.sessionPolicy === null) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, `Invalid ${label}.session-policy (expected object)`);
    }

    const sp = agent.sessionPolicy as Record<string, unknown>;
    if (sp.dailyResetAt !== undefined) {
      if (typeof sp.dailyResetAt !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, `Invalid ${label}.session-policy.daily-reset-at`);
      }
      sp.dailyResetAt = parseDailyResetAt(sp.dailyResetAt).normalized;
    }
    if (sp.idleTimeout !== undefined) {
      if (typeof sp.idleTimeout !== "string") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, `Invalid ${label}.session-policy.idle-timeout`);
      }
      parseDurationToMs(sp.idleTimeout);
      sp.idleTimeout = sp.idleTimeout.trim();
    }
    if ((sp as any).maxTokens !== undefined) {
      rpcError(
        RPC_ERRORS.INVALID_PARAMS,
        `Invalid ${label}.session-policy.max-tokens (use max-context-length)`
      );
    }
    if (sp.maxContextLength !== undefined) {
      if (typeof sp.maxContextLength !== "number" || !Number.isFinite(sp.maxContextLength)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, `Invalid ${label}.session-policy.max-context-length`);
      }
      if (sp.maxContextLength <= 0) {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          `Invalid ${label}.session-policy.max-context-length (must be > 0)`
        );
      }
      (sp as any).maxContextLength = Math.trunc(sp.maxContextLength);
    }
  }

  if (agent.metadata !== undefined) {
    if (typeof agent.metadata !== "object" || agent.metadata === null || Array.isArray(agent.metadata)) {
      rpcError(RPC_ERRORS.INVALID_PARAMS, `Invalid ${label}.metadata (expected object)`);
    }
  }
}

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
      const completed = ctx.db.isSetupComplete();
      const agents = ctx.db.listAgents();
      const bindings = ctx.db.listBindings();
      const roleCounts = ctx.db.getAgentRoleCounts();
      const missingRoles: Array<"speaker" | "leader"> = [];
      if (roleCounts.speaker < 1) missingRoles.push("speaker");
      if (roleCounts.leader < 1) missingRoles.push("leader");
      const integrityView = toSpeakerBindingIntegrityView(
        getSpeakerBindingIntegrity({
          agents,
          bindings,
        })
      );

      const bossName = (ctx.db.getBossName() ?? "").trim();
      const bossTimezone = (ctx.db.getConfig("boss_timezone") ?? "").trim();
      const telegramBossId = (ctx.db.getAdapterBossId("telegram") ?? "").trim();
      const hasBossToken = Boolean((ctx.db.getConfig("boss_token_hash") ?? "").trim());
      const missingUserInfo = {
        bossName: bossName.length === 0,
        bossTimezone: bossTimezone.length === 0,
        telegramBossId: telegramBossId.length === 0,
        bossToken: !hasBossToken,
      };
      const memoryConfigured = Boolean((ctx.db.getConfig("memory_model_source") ?? "").trim());
      const hasMissingUserInfo = Object.values(missingUserInfo).some(Boolean);
      const hasIntegrityViolations =
        integrityView.speakerWithoutBindings.length > 0 ||
        integrityView.duplicateSpeakerBindings.length > 0;

      return {
        completed,
        ready:
          completed &&
          missingRoles.length === 0 &&
          !hasMissingUserInfo &&
          memoryConfigured &&
          !hasIntegrityViolations,
        roleCounts,
        missingRoles,
        integrity: integrityView,
        agents: agents.map((agent) => ({
          name: agent.name,
          role: agent.role,
          workspace: agent.workspace,
          provider: agent.provider,
        })),
        userInfo: {
          bossName: bossName || undefined,
          bossTimezone: bossTimezone || undefined,
          telegramBossId: telegramBossId || undefined,
          hasBossToken,
          missing: missingUserInfo,
        },
        memoryConfigured,
      };
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

      const speakerAgentName = validateSetupAgentName(p.speakerAgent.name);
      const leaderAgentName = validateSetupAgentName(p.leaderAgent.name);
      if (speakerAgentName.toLowerCase() === leaderAgentName.toLowerCase()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid setup agents (speaker-agent and leader-agent must be different)");
      }
      validateSetupAgentConfig(p.speakerAgent, "speaker-agent");
      validateSetupAgentConfig(p.leaderAgent, "leader-agent");

      if (p.speakerAgent.provider !== "claude" && p.speakerAgent.provider !== "codex") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid speaker-agent.provider (expected claude or codex)");
      }
      if (p.leaderAgent.provider !== "claude" && p.leaderAgent.provider !== "codex") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid leader-agent.provider (expected claude or codex)");
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
      await setupAgentHome(speakerAgentName, ctx.config.dataDir);
      await setupAgentHome(leaderAgentName, ctx.config.dataDir);
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

      let createdSpeakerAgentToken: string;
      let createdLeaderAgentToken: string;
      try {
        const createdTokens = ctx.db.runInTransaction(() => {
          // Set boss name
          ctx.db.setBossName(p.bossName);

          // Set boss timezone (used for all displayed timestamps)
          ctx.db.setConfig("boss_timezone", bossTimezone || getDaemonIanaTimeZone());

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

          // Create speaker agent
          const speakerMetadata =
            p.speakerAgent.metadata && typeof p.speakerAgent.metadata === "object" && !Array.isArray(p.speakerAgent.metadata)
              ? (() => {
                  const copy = { ...(p.speakerAgent.metadata as Record<string, unknown>) };
                  // Reserved internal metadata key (best-effort session resume handle).
                  delete copy.sessionHandle;
                  return copy;
                })()
              : undefined;

          const speakerAgentResult = ctx.db.registerAgent({
            name: speakerAgentName,
            role: "speaker",
            description: p.speakerAgent.description,
            workspace: p.speakerAgent.workspace,
            provider: p.speakerAgent.provider,
            model: p.speakerAgent.model,
            reasoningEffort: p.speakerAgent.reasoningEffort,
            permissionLevel: p.speakerAgent.permissionLevel,
            sessionPolicy: p.speakerAgent.sessionPolicy,
            metadata: speakerMetadata,
          });

          // Create leader agent
          const leaderMetadata =
            p.leaderAgent.metadata && typeof p.leaderAgent.metadata === "object" && !Array.isArray(p.leaderAgent.metadata)
              ? (() => {
                  const copy = { ...(p.leaderAgent.metadata as Record<string, unknown>) };
                  delete copy.sessionHandle;
                  return copy;
                })()
              : undefined;

          const leaderAgentResult = ctx.db.registerAgent({
            name: leaderAgentName,
            role: "leader",
            description: p.leaderAgent.description,
            workspace: p.leaderAgent.workspace,
            provider: p.leaderAgent.provider,
            model: p.leaderAgent.model,
            reasoningEffort: p.leaderAgent.reasoningEffort,
            permissionLevel: p.leaderAgent.permissionLevel,
            sessionPolicy: p.leaderAgent.sessionPolicy,
            metadata: leaderMetadata,
          });

          // Create adapter binding if provided
          ctx.db.createBinding(speakerAgentName, p.adapter.adapterType, p.adapter.adapterToken);

          // Store boss ID for this adapter
          ctx.db.setAdapterBossId(p.adapter.adapterType, p.adapter.adapterBossId.trim().replace(/^@/, ""));

          // Set boss token
          ctx.db.setBossToken(p.bossToken.trim());

          // Mark setup as complete
          ctx.db.markSetupComplete();

          return {
            speakerAgentToken: speakerAgentResult.token,
            leaderAgentToken: leaderAgentResult.token,
          };
        });
        createdSpeakerAgentToken = createdTokens.speakerAgentToken;
        createdLeaderAgentToken = createdTokens.leaderAgentToken;
      } catch (err) {
        // Roll back any adapter started during setup if DB commit fails.
        if (createdAdapterForSetup && adapterToken) {
          await ctx.removeAdapter(adapterToken).catch(() => undefined);
        }
        throw err;
      }

      // Register agent handler for auto-execution
      ctx.registerAgentHandler(speakerAgentName);
      ctx.registerAgentHandler(leaderAgentName);

      return {
        speakerAgentToken: createdSpeakerAgentToken,
        leaderAgentToken: createdLeaderAgentToken,
      };
    },

    // Boss methods
    "boss.verify": async (params) => {
      const p = params as unknown as BossVerifyParams;
      return { valid: ctx.db.verifyBossToken(p.token) };
    },
  };
}
