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
  DEFAULT_AGENT_AUTO_LEVEL,
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
} from "../../shared/defaults.js";
import { isPermissionLevel } from "../../shared/permissions.js";
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

      const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName.trim());
      if (!agent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }
      const agentName = agent.name;
      resolvedAgentName = agentName;

      const wantsBind = p.bindAdapterType !== undefined || p.bindAdapterToken !== undefined;
      const wantsUnbind = p.unbindAdapterType !== undefined;

      const hasAnyUpdate =
        p.description !== undefined ||
        p.workspace !== undefined ||
        p.provider !== undefined ||
        p.model !== undefined ||
        p.reasoningEffort !== undefined ||
        p.autoLevel !== undefined ||
        p.permissionLevel !== undefined ||
        p.sessionPolicy !== undefined ||
        p.metadata !== undefined ||
        wantsBind ||
        wantsUnbind;

      if (!hasAnyUpdate) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "No updates provided");
      }

      changedKeys = [
        ...(p.description !== undefined ? ["description"] : []),
        ...(p.workspace !== undefined ? ["workspace"] : []),
        ...(p.provider !== undefined ? ["provider"] : []),
        ...(p.providerSourceHome !== undefined ? ["provider-source-home"] : []),
        ...(p.model !== undefined ? ["model"] : []),
        ...(p.reasoningEffort !== undefined ? ["reasoning-effort"] : []),
        ...(p.autoLevel !== undefined ? ["auto-level"] : []),
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

      if (wantsUnbind) {
        if (typeof p.unbindAdapterType !== "string" || !p.unbindAdapterType.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid unbind-adapter-type");
        }
      }

      if (wantsBind && wantsUnbind) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Cannot bind and unbind in the same request");
      }

      let provider: "claude" | "codex" | null | undefined;
      if (p.provider !== undefined) {
        if (p.provider !== null && p.provider !== "claude" && p.provider !== "codex") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid provider (expected claude or codex)");
        }
        provider = p.provider;
      }

      let providerSourceHome: string | undefined;
      if (p.providerSourceHome !== undefined) {
        if (typeof p.providerSourceHome !== "string" || !p.providerSourceHome.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid provider-source-home");
        }
        providerSourceHome = p.providerSourceHome.trim();
      }
      if (providerSourceHome !== undefined && (provider === undefined || provider === null)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "--provider-source-home requires --provider");
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

      let autoLevel: Agent["autoLevel"] | null | undefined;
      if (p.autoLevel !== undefined) {
        if (p.autoLevel !== null && p.autoLevel !== "medium" && p.autoLevel !== "high") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid auto-level (expected medium, high)");
        }
        autoLevel = p.autoLevel;
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
          metadata = p.metadata;
        } else {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid metadata (expected object or null)");
        }
      }

      const before = ctx.db.getAgentByName(agentName)!;

      if (provider === "claude" || provider === "codex") {
        try {
          await setupAgentHome(agentName, ctx.config.dataDir, {
            provider,
            providerSourceHome,
          });
        } catch (err) {
          const message = (err as Error).message || String(err);
          if (message.includes("provider-source-home")) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, message);
          }
          throw err;
        }
      }

      // Bind/unbind are async due to adapter start/stop; do those outside the DB transaction.
      if (wantsUnbind) {
        const adapterType = (p.unbindAdapterType as string).trim();
        const binding = ctx.db.getAgentBindingByType(agentName, adapterType);
        if (!binding) {
          rpcError(RPC_ERRORS.NOT_FOUND, "Binding not found");
        }

        await ctx.removeAdapter(binding.adapterToken);
        ctx.db.deleteBinding(agentName, adapterType);
      }

      if (wantsBind) {
        const adapterType = (p.bindAdapterType as string).trim();
        const adapterToken = (p.bindAdapterToken as string).trim();

        const existingBinding = ctx.db.getBindingByAdapter(adapterType, adapterToken);
        if (existingBinding && existingBinding.agentName !== agentName) {
          rpcError(
            RPC_ERRORS.ALREADY_EXISTS,
            `This ${adapterType} bot is already bound to agent '${existingBinding.agentName}'`
          );
        }

        const agentBinding = ctx.db.getAgentBindingByType(agentName, adapterType);
        if (agentBinding) {
          rpcError(RPC_ERRORS.ALREADY_EXISTS, `Agent '${agentName}' already has a ${adapterType} binding`);
        }

        const hadAdapterAlready = ctx.adapters.has(adapterToken);
        let createdAdapterForSet = false;

        if (ctx.running) {
          try {
            const adapter = await ctx.createAdapterForBinding(adapterType, adapterToken);
            if (!adapter) {
              rpcError(RPC_ERRORS.INVALID_PARAMS, `Unknown adapter type: ${adapterType}`);
            }
            createdAdapterForSet = !hadAdapterAlready;
          } catch (err) {
            if (!hadAdapterAlready) {
              await ctx.removeAdapter(adapterToken).catch(() => undefined);
            }
            throw err;
          }
        }

        try {
          ctx.db.createBinding(agentName, adapterType, adapterToken);
        } catch (err) {
          if (createdAdapterForSet) {
            await ctx.removeAdapter(adapterToken).catch(() => undefined);
          }
          throw err;
        }
      }

      const updates: {
        description?: string | null;
        workspace?: string | null;
        provider?: "claude" | "codex" | null;
        model?: string | null;
        reasoningEffort?: Agent["reasoningEffort"] | null;
        autoLevel?: Agent["autoLevel"] | null;
      } = {};

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

      if (autoLevel !== undefined) {
        updates.autoLevel = autoLevel;
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
          ctx.db.updateAgentMetadata(agentName, metadata);
        }
      });

      const updated = ctx.db.getAgentByName(agentName)!;
      const bindings = ctx.db.getBindingsByAgentName(agentName).map((b) => b.adapterType);

      const needsRefresh =
        (provider !== undefined && before.provider !== updated.provider) ||
        (p.model !== undefined && before.model !== updated.model) ||
        (reasoningEffort !== undefined && before.reasoningEffort !== updated.reasoningEffort) ||
        (autoLevel !== undefined && before.autoLevel !== updated.autoLevel) ||
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
          description: updated.description,
          workspace: updated.workspace,
          provider: updated.provider ?? DEFAULT_AGENT_PROVIDER,
          model: updated.model,
          reasoningEffort: updated.reasoningEffort,
          autoLevel: updated.autoLevel ?? DEFAULT_AGENT_AUTO_LEVEL,
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
