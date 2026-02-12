/**
 * Agent.set RPC handler.
 *
 * Complex handler in its own file due to the many update options it supports.
 */

import type { RpcMethodRegistry, AgentSetParams } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import type { Agent } from "../../agent/types.js";
import { setupAgentHome } from "../../agent/home-setup.js";
import { parseDailyResetAt, parseDurationToMs } from "../../shared/session-policy.js";
import {
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
} from "../../shared/defaults.js";
import { isPermissionLevel } from "../../shared/permissions.js";
import { isAgentRole, resolveAgentRole } from "../../shared/agent-role.js";
import {
  predictRoleAfterBindingMutation,
  predictRoleAfterExplicitMutation,
  buildMutationInvariantViolationMessage,
} from "../../shared/agent-role-mutation.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";

/**
 * Create agent.set RPC handler.
 */
export function createAgentSetHandler(ctx: DaemonContext): RpcMethodRegistry {
  return {
    "agent.set": async (params) => {
      const p = params as unknown as AgentSetParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("agent.set", principal);

      const startedAtMs = Date.now();
      const requestedAgentName = typeof p.agentName === "string" ? p.agentName.trim() : "";
      let resolvedAgentName: string | undefined;
      let changedKeys: string[] = [];

      try {
      if (typeof p.agentName !== "string" || !p.agentName.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid agent-name");
      }

      if ((p as any).providerSourceHome !== undefined) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "provider-source-home is no longer supported");
      }

      const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName.trim());
      if (!agent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }
      const agentName = agent.name;
      resolvedAgentName = agentName;

      const wantsBind = p.bindAdapterType !== undefined || p.bindAdapterToken !== undefined;
      const wantsUnbind = p.unbindAdapterType !== undefined;

      const hasAnyUpdate =
        p.role !== undefined ||
        p.description !== undefined ||
        p.workspace !== undefined ||
        p.provider !== undefined ||
        p.model !== undefined ||
        p.reasoningEffort !== undefined ||
        p.permissionLevel !== undefined ||
        p.sessionPolicy !== undefined ||
        p.metadata !== undefined ||
        wantsBind ||
        wantsUnbind;

      if (!hasAnyUpdate) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "No updates provided");
      }

      changedKeys = [
        ...(p.role !== undefined ? ["role"] : []),
        ...(p.description !== undefined ? ["description"] : []),
        ...(p.workspace !== undefined ? ["workspace"] : []),
        ...(p.provider !== undefined ? ["provider"] : []),
        ...(p.model !== undefined ? ["model"] : []),
        ...(p.reasoningEffort !== undefined ? ["reasoning-effort"] : []),
        ...(p.permissionLevel !== undefined ? ["permission-level"] : []),
        ...(p.sessionPolicy !== undefined ? ["session-policy"] : []),
        ...(p.metadata !== undefined ? ["metadata"] : []),
        ...(wantsBind ? ["bind-adapter"] : []),
        ...(wantsUnbind ? ["unbind-adapter"] : []),
      ];

      if (wantsBind) {
        if (typeof p.bindAdapterType !== "string" || !p.bindAdapterType.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid bind-adapter-type");
        }
        if (typeof p.bindAdapterToken !== "string" || !p.bindAdapterToken.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid bind-adapter-token");
        }
      }

      const bindAdapterType = wantsBind ? (p.bindAdapterType as string).trim() : undefined;
      const bindAdapterToken = wantsBind ? (p.bindAdapterToken as string).trim() : undefined;
      const unbindAdapterType = wantsUnbind ? (p.unbindAdapterType as string).trim() : undefined;

      const allAgents = ctx.db.listAgents();
      const allBindings = ctx.db.listBindings();
      const bindingsForAgent = allBindings.filter((binding) => binding.agentName === agentName);
      const currentBindingCount = bindingsForAgent.length;

      const unbindBinding =
        unbindAdapterType !== undefined
          ? ctx.db.getAgentBindingByType(agentName, unbindAdapterType)
          : null;
      if (wantsUnbind) {
        if (typeof p.unbindAdapterType !== "string" || !p.unbindAdapterType.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid unbind-adapter-type");
        }
        if (!unbindBinding) {
          rpcError(RPC_ERRORS.NOT_FOUND, "Binding not found");
        }
      }

      const existingBindingByType =
        bindAdapterType !== undefined
          ? ctx.db.getAgentBindingByType(agentName, bindAdapterType)
          : null;
      if (bindAdapterType && bindAdapterToken) {
        const existingBindingByToken = ctx.db.getBindingByAdapter(bindAdapterType, bindAdapterToken);
        if (existingBindingByToken && existingBindingByToken.agentName !== agentName) {
          rpcError(
            RPC_ERRORS.ALREADY_EXISTS,
            `This ${bindAdapterType} bot is already bound to agent '${existingBindingByToken.agentName}'`
          );
        }
      }

      const currentBindingTypes = new Set(bindingsForAgent.map((binding) => binding.adapterType));
      const nextBindingTypes = new Set(currentBindingTypes);
      if (unbindAdapterType) nextBindingTypes.delete(unbindAdapterType);
      if (bindAdapterType) nextBindingTypes.add(bindAdapterType);
      const nextBindingCount = nextBindingTypes.size;
      const bindingCountDelta = nextBindingCount - currentBindingCount;

      let role: "speaker" | "leader" | undefined;
      if (p.role !== undefined) {
        if (!isAgentRole(p.role)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid role (expected speaker or leader)");
        }
        role = p.role;

        // Validate post-role-change invariant
        const prediction = predictRoleAfterExplicitMutation({
          agent,
          newRole: p.role,
          allAgents,
          allBindings,
        });

        if (prediction.breaking) {
          const message = buildMutationInvariantViolationMessage({
            operation: "set-role",
            agentName: agentName,
            prediction,
          });
          logEvent("warn", "agent-set-role-blocked-invariant", {
            "agent-name": agentName,
            "current-role": prediction.before,
            "requested-role": prediction.after,
            "missing-role": prediction.missingRole,
          });
          rpcError(RPC_ERRORS.INVALID_PARAMS, message);
        }
      }

      if (role === "speaker" && nextBindingCount < 1) {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          "Setting role to speaker requires at least one adapter binding in the same command."
        );
      }

      const roleAfterMutation =
        role ??
        resolveAgentRole({
          metadata: agent.metadata,
          bindingCount: nextBindingCount,
        });

      if (wantsUnbind && roleAfterMutation === "speaker" && nextBindingCount < 1) {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          "Cannot unbind the last adapter from speaker agent. Bind another adapter or change role to leader in the same command."
        );
      }

      if (wantsUnbind && role !== "leader" && bindingCountDelta < 0) {
        const prediction = predictRoleAfterBindingMutation({
          agent,
          bindingCountDelta,
          allAgents,
          allBindings,
        });

        if (prediction.breaking) {
          const message = buildMutationInvariantViolationMessage({
            operation: "unbind",
            agentName: agentName,
            prediction,
          });
          logEvent("warn", "agent-set-unbind-blocked-invariant", {
            "agent-name": agentName,
            "current-role": prediction.before,
            "would-flip-to": prediction.after,
            "missing-role": prediction.missingRole,
          });
          rpcError(RPC_ERRORS.INVALID_PARAMS, message);
        }
      }

      let provider: "claude" | "codex" | null | undefined;
      if (p.provider !== undefined) {
        if (p.provider !== null && p.provider !== "claude" && p.provider !== "codex") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid provider (expected claude or codex)");
        }
        provider = p.provider;
      }

      let reasoningEffort: Agent["reasoningEffort"] | null | undefined;
      if (p.reasoningEffort !== undefined) {
        if (
          p.reasoningEffort !== null &&
          p.reasoningEffort !== "none" &&
          p.reasoningEffort !== "low" &&
          p.reasoningEffort !== "medium" &&
          p.reasoningEffort !== "high" &&
          p.reasoningEffort !== "xhigh"
        ) {
          rpcError(
            RPC_ERRORS.INVALID_PARAMS,
            "Invalid reasoning-effort (expected none, low, medium, high, xhigh)"
          );
        }
        reasoningEffort = p.reasoningEffort;
      }

      let permissionLevel: Agent["permissionLevel"] | undefined;
      if (p.permissionLevel !== undefined) {
        if (principal.level !== "boss") {
          rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
        }
        if (!isPermissionLevel(p.permissionLevel)) {
          rpcError(
            RPC_ERRORS.INVALID_PARAMS,
            "Invalid permission-level (expected restricted, standard, privileged, boss)"
          );
        }
        permissionLevel = p.permissionLevel;
      }

      let sessionPolicyUpdate:
        | { clear: true }
        | { dailyResetAt?: string; idleTimeout?: string; maxContextLength?: number }
        | undefined;
      if (p.sessionPolicy !== undefined) {
        if (p.sessionPolicy === null) {
          sessionPolicyUpdate = { clear: true };
        } else if (typeof p.sessionPolicy === "object" && p.sessionPolicy !== null && !Array.isArray(p.sessionPolicy)) {
          const raw = p.sessionPolicy as Record<string, unknown>;
          const next: { dailyResetAt?: string; idleTimeout?: string; maxContextLength?: number } = {};

          if (raw.dailyResetAt !== undefined) {
            if (typeof raw.dailyResetAt !== "string") {
              rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.daily-reset-at");
            }
            next.dailyResetAt = parseDailyResetAt(raw.dailyResetAt).normalized;
          }

          if (raw.idleTimeout !== undefined) {
            if (typeof raw.idleTimeout !== "string") {
              rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.idle-timeout");
            }
            parseDurationToMs(raw.idleTimeout);
            next.idleTimeout = raw.idleTimeout.trim();
          }

          if ((raw as any).maxTokens !== undefined) {
            rpcError(
              RPC_ERRORS.INVALID_PARAMS,
              "Invalid session-policy.max-tokens (use max-context-length)"
            );
          }

          if (raw.maxContextLength !== undefined) {
            if (typeof raw.maxContextLength !== "number" || !Number.isFinite(raw.maxContextLength)) {
              rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.max-context-length");
            }
            if (raw.maxContextLength <= 0) {
              rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.max-context-length (must be > 0)");
            }
            next.maxContextLength = Math.trunc(raw.maxContextLength);
          }

          if (Object.keys(next).length === 0) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "No session policy values provided");
          }

          sessionPolicyUpdate = next;
        } else {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy (expected object or null)");
        }
      }

      let metadata: Record<string, unknown> | null | undefined;
      if (p.metadata !== undefined) {
        if (p.metadata === null) {
          metadata = null;
        } else if (typeof p.metadata === "object" && p.metadata !== null && !Array.isArray(p.metadata)) {
          const copy = { ...(p.metadata as Record<string, unknown>) };
          // Reserved internal metadata key (best-effort session resume handle).
          delete copy.sessionHandle;
          metadata = copy;
        } else {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid metadata (expected object or null)");
        }
      }

      const before = ctx.db.getAgentByName(agentName)!;

      if (provider === "claude" || provider === "codex") {
        await setupAgentHome(agentName, ctx.config.dataDir);
      }

      const unbindSameType = Boolean(
        unbindAdapterType && bindAdapterType && unbindAdapterType === bindAdapterType
      );
      const bindWouldCreateOrReplace = Boolean(
        bindAdapterType &&
          bindAdapterToken &&
          (
            !existingBindingByType ||
            existingBindingByType.adapterToken !== bindAdapterToken ||
            unbindSameType
          )
      );

      let createdAdapterForSet = false;
      if (bindAdapterType && bindAdapterToken && bindWouldCreateOrReplace && ctx.running) {
        const hadAdapterAlready = ctx.adapters.has(bindAdapterToken);
        try {
          const adapter = await ctx.createAdapterForBinding(bindAdapterType, bindAdapterToken);
          if (!adapter) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, `Unknown adapter type: ${bindAdapterType}`);
          }
          createdAdapterForSet = !hadAdapterAlready;
        } catch (err) {
          if (!hadAdapterAlready) {
            await ctx.removeAdapter(bindAdapterToken).catch(() => undefined);
          }
          throw err;
        }
      }

      try {
        if (wantsUnbind || wantsBind) {
          ctx.db.runInTransaction(() => {
            if (wantsUnbind && unbindAdapterType) {
              ctx.db.deleteBinding(agentName, unbindAdapterType);
            }

            if (bindAdapterType && bindAdapterToken) {
              if (!existingBindingByType) {
                ctx.db.createBinding(agentName, bindAdapterType, bindAdapterToken);
              } else if (existingBindingByType.adapterToken === bindAdapterToken) {
                if (unbindSameType) {
                  ctx.db.createBinding(agentName, bindAdapterType, bindAdapterToken);
                }
              } else {
                if (!unbindSameType) {
                  ctx.db.deleteBinding(agentName, bindAdapterType);
                }
                ctx.db.createBinding(agentName, bindAdapterType, bindAdapterToken);
              }
            }
          });
        }
      } catch (err) {
        if (createdAdapterForSet && bindAdapterToken) {
          await ctx.removeAdapter(bindAdapterToken).catch(() => undefined);
        }
        throw err;
      }

      const adapterTokensToRemove = new Set<string>();
      if (unbindBinding && (!bindAdapterToken || bindAdapterToken !== unbindBinding.adapterToken)) {
        adapterTokensToRemove.add(unbindBinding.adapterToken);
      }
      if (
        existingBindingByType &&
        bindWouldCreateOrReplace &&
        bindAdapterToken &&
        existingBindingByType.adapterToken !== bindAdapterToken
      ) {
        adapterTokensToRemove.add(existingBindingByType.adapterToken);
      }
      for (const adapterToken of adapterTokensToRemove) {
        await ctx.removeAdapter(adapterToken);
      }

      const updates: {
        role?: "speaker" | "leader";
        description?: string | null;
        workspace?: string | null;
        provider?: "claude" | "codex" | null;
        model?: string | null;
        reasoningEffort?: Agent["reasoningEffort"] | null;
      } = {};

      if (role !== undefined) {
        updates.role = role;
      }

      if (p.description !== undefined) {
        if (p.description !== null && typeof p.description !== "string") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid description");
        }
        const trimmed = typeof p.description === "string" ? p.description.trim() : null;
        updates.description = trimmed && trimmed.length > 0 ? trimmed : null;
      }

      if (p.workspace !== undefined) {
        if (p.workspace !== null && typeof p.workspace !== "string") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid workspace");
        }
        const trimmed = typeof p.workspace === "string" ? p.workspace.trim() : null;
        updates.workspace = trimmed && trimmed.length > 0 ? trimmed : null;
      }

      if (provider !== undefined) {
        updates.provider = provider;
      }

      // Experiment: when switching providers, clear model/reasoning-effort unless explicitly set.
      // This avoids carrying incompatible model overrides across providers.
      const providerChanged =
        (provider === "claude" || provider === "codex") &&
        before.provider !== provider;
      if (providerChanged) {
        if (p.model === undefined) {
          updates.model = null;
        }
        if (p.reasoningEffort === undefined) {
          updates.reasoningEffort = null;
        }
      }

      if (p.model !== undefined) {
        if (p.model !== null && typeof p.model !== "string") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid model");
        }
        const trimmed = typeof p.model === "string" ? p.model.trim() : null;
        updates.model = trimmed && trimmed.length > 0 ? trimmed : null;
      }

      if (reasoningEffort !== undefined) {
        updates.reasoningEffort = reasoningEffort;
      }

      ctx.db.runInTransaction(() => {
        if (Object.keys(updates).length > 0) {
          ctx.db.updateAgentFields(agentName, updates);
        }

        if (permissionLevel !== undefined) {
          ctx.db.setAgentPermissionLevel(agentName, permissionLevel);
        }

        if (sessionPolicyUpdate !== undefined) {
          if ("clear" in sessionPolicyUpdate) {
            ctx.db.updateAgentSessionPolicy(agentName, { clear: true });
          } else {
            ctx.db.updateAgentSessionPolicy(agentName, sessionPolicyUpdate);
          }
        }

        if (metadata !== undefined) {
          ctx.db.replaceAgentMetadataPreservingSessionHandle(agentName, metadata);
        }
      });

      const updated = ctx.db.getAgentByName(agentName)!;
      const bindings = ctx.db.getBindingsByAgentName(agentName).map((b) => b.adapterType);

      const needsRefresh =
        (p.workspace !== undefined && before.workspace !== updated.workspace);

      if (needsRefresh) {
        ctx.executor.requestSessionRefresh(agentName, "rpc:agent.set");
      }

      logEvent("info", "agent-set", {
        actor: principal.kind,
        "agent-name": agentName,
        changed: changedKeys.length > 0 ? changedKeys.join(",") : undefined,
        state: "success",
        "duration-ms": Date.now() - startedAtMs,
      });
      return {
        success: true,
        agent: {
          name: updated.name,
          role: updated.role,
          description: updated.description,
          workspace: updated.workspace,
          provider: updated.provider ?? DEFAULT_AGENT_PROVIDER,
          model: updated.model,
          reasoningEffort: updated.reasoningEffort,
          permissionLevel: updated.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL,
          sessionPolicy: updated.sessionPolicy,
          metadata: updated.metadata,
        },
        bindings,
      };
      } catch (err) {
        logEvent("info", "agent-set", {
          actor: principal.kind,
          "agent-name": (resolvedAgentName ?? requestedAgentName) || undefined,
          changed: changedKeys.length > 0 ? changedKeys.join(",") : undefined,
          state: "failed",
          "duration-ms": Date.now() - startedAtMs,
          error: errorMessage(err),
        });
        throw err;
      }
    },
  };
}
