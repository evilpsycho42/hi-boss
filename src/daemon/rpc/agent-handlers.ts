/**
 * Agent management RPC handlers.
 *
 * Handles: agent.register, agent.list, agent.bind, agent.unbind,
 * agent.refresh, agent.abort, agent.self, agent.session-policy.set, agent.status
 */

import type {
  RpcMethodRegistry,
  AgentBindParams,
  AgentUnbindParams,
  AgentRefreshParams,
  AgentAbortParams,
  AgentAbortResult,
  AgentSelfParams,
  AgentStatusParams,
  AgentStatusResult,
  AgentSessionPolicySetParams,
} from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import { isValidAgentName, AGENT_NAME_ERROR_MESSAGE } from "../../shared/validation.js";
import { parseDailyResetAt, parseDurationToMs } from "../../shared/session-policy.js";
import {
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  getDefaultRuntimeWorkspace,
} from "../../shared/defaults.js";
import { createAgentRegisterHandler } from "./agent-register-handler.js";
import { parseAgentRoleFromMetadata, resolveAgentRole } from "../../shared/agent-role.js";
import {
  predictRoleAfterBindingMutation,
  buildMutationInvariantViolationMessage,
} from "../../shared/agent-role-mutation.js";

/**
 * Create agent RPC handlers (excluding agent.set which is in its own file).
 */
export function createAgentHandlers(ctx: DaemonContext): RpcMethodRegistry {
  const requireRole = (agentName: string, metadata: Record<string, unknown> | undefined): "speaker" | "leader" => {
    const role = parseAgentRoleFromMetadata(metadata);
    if (!role) {
      rpcError(
        RPC_ERRORS.INTERNAL_ERROR,
        `Agent '${agentName}' is missing required role metadata. Run: hiboss agent set --name ${agentName} --role <speaker|leader>`
      );
    }
    return role;
  };

  return {
    "agent.register": createAgentRegisterHandler(ctx),

    "agent.list": async (params) => {
      const p = params as unknown as { token: string };
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("agent.list", principal);

      const agents = ctx.db.listAgents();
      const bindings = ctx.db.listBindings();

      // Group bindings by agent
      const bindingsByAgent = new Map<string, string[]>();
      for (const b of bindings) {
        const list = bindingsByAgent.get(b.agentName) ?? [];
        list.push(b.adapterType);
        bindingsByAgent.set(b.agentName, list);
      }

      return {
        agents: agents.map((a) => ({
          name: a.name,
          role: requireRole(a.name, a.metadata),
          description: a.description,
          workspace: a.workspace,
          provider: a.provider,
          model: a.model,
          reasoningEffort: a.reasoningEffort,
          permissionLevel: a.permissionLevel,
          sessionPolicy: a.sessionPolicy,
          createdAt: a.createdAt,
          lastSeenAt: a.lastSeenAt,
          metadata: a.metadata,
          bindings: bindingsByAgent.get(a.name) ?? [],
        })),
      };
    },

    "agent.status": async (params) => {
      const p = params as unknown as AgentStatusParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("agent.status", principal);

      if (typeof p.agentName !== "string" || !isValidAgentName(p.agentName)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, AGENT_NAME_ERROR_MESSAGE);
      }

      if (principal.kind === "agent" && principal.agent.name !== p.agentName) {
        rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
      }

      const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName);
      if (!agent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }

      const effectiveProvider = agent.provider ?? DEFAULT_AGENT_PROVIDER;
      const effectivePermissionLevel = agent.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL;
      const effectiveWorkspace = agent.workspace ?? getDefaultRuntimeWorkspace();

      const isBusy = ctx.executor.isAgentBusy(agent.name);
      const pendingCount = ctx.db.countDuePendingEnvelopesForAgent(agent.name);
      const bindings = ctx.db.getBindingsByAgentName(agent.name).map((b) => b.adapterType);
      const resolvedRole = requireRole(agent.name, agent.metadata);

      const currentRun = isBusy ? ctx.db.getCurrentRunningAgentRun(agent.name) : null;
      const lastRun = ctx.db.getLastFinishedAgentRun(agent.name);

      const result: AgentStatusResult = {
        agent: {
          name: agent.name,
          role: resolvedRole,
          ...(agent.description ? { description: agent.description } : {}),
          ...(agent.workspace ? { workspace: agent.workspace } : {}),
          ...(agent.provider ? { provider: agent.provider } : {}),
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
          ...(agent.permissionLevel ? { permissionLevel: agent.permissionLevel } : {}),
          ...(agent.sessionPolicy ? { sessionPolicy: agent.sessionPolicy } : {}),
        },
        bindings,
        effective: {
          workspace: effectiveWorkspace,
          provider: effectiveProvider,
          permissionLevel: effectivePermissionLevel,
        },
        status: {
          agentState: isBusy ? "running" : "idle",
          agentHealth: !lastRun ? "unknown" : lastRun.status === "failed" ? "error" : "ok",
          pendingCount,
          ...(currentRun
            ? {
              currentRun: {
                id: currentRun.id,
                startedAt: currentRun.startedAt,
              },
            }
            : {}),
          ...(lastRun
            ? {
              lastRun: {
                id: lastRun.id,
                startedAt: lastRun.startedAt,
                ...(typeof lastRun.completedAt === "number" ? { completedAt: lastRun.completedAt } : {}),
                status:
                  lastRun.status === "failed"
                    ? "failed"
                    : lastRun.status === "cancelled"
                      ? "cancelled"
                      : "completed",
                ...(lastRun.error ? { error: lastRun.error } : {}),
                ...(typeof lastRun.contextLength === "number"
                  ? { contextLength: lastRun.contextLength }
                  : {}),
              },
            }
            : {}),
        },
      };

      return result;
    },

    "agent.abort": async (params) => {
      const p = params as unknown as AgentAbortParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("agent.abort", principal);

      if (typeof p.agentName !== "string" || !isValidAgentName(p.agentName)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, AGENT_NAME_ERROR_MESSAGE);
      }

      if (principal.kind === "agent" && principal.agent.name !== p.agentName) {
        rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
      }

      const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName);
      if (!agent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }

      const cancelledRun = ctx.executor.abortCurrentRun(agent.name, "rpc:agent.abort");
      const clearedPendingCount = ctx.db.markDuePendingNonCronEnvelopesDoneForAgent(agent.name);

      const result: AgentAbortResult = {
        success: true,
        agentName: agent.name,
        cancelledRun,
        clearedPendingCount,
      };

      return result;
    },

    "agent.bind": async (params) => {
      const p = params as unknown as AgentBindParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("agent.bind", principal);

      // Check if agent exists
      const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName);
      if (!agent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }

      const agentName = agent.name;

      // Check if this adapter token is already bound to another agent
      const existingBinding = ctx.db.getBindingByAdapter(p.adapterType, p.adapterToken);
      if (existingBinding && existingBinding.agentName !== agentName) {
        rpcError(
          RPC_ERRORS.ALREADY_EXISTS,
          `This ${p.adapterType} bot is already bound to agent '${existingBinding.agentName}'`
        );
      }

      // Check if agent already has a binding for this adapter type
      const agentBinding = ctx.db.getAgentBindingByType(agentName, p.adapterType);
      if (agentBinding) {
        rpcError(
          RPC_ERRORS.ALREADY_EXISTS,
          `Agent '${agentName}' already has a ${p.adapterType} binding`
        );
      }

      // Create binding
      const binding = ctx.db.createBinding(agentName, p.adapterType, p.adapterToken);

      // Create adapter if daemon is running
      if (ctx.running) {
        await ctx.createAdapterForBinding(p.adapterType, p.adapterToken);
      }

      return {
        binding: {
          id: binding.id,
          agentName: binding.agentName,
          adapterType: binding.adapterType,
          createdAt: binding.createdAt,
        },
      };
    },

    "agent.unbind": async (params) => {
      const p = params as unknown as AgentUnbindParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("agent.unbind", principal);

      const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName);
      if (!agent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }
      const agentName = agent.name;

      // Get the binding to find the adapter token
      const binding = ctx.db.getAgentBindingByType(agentName, p.adapterType);
      if (!binding) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Binding not found");
      }

      const allAgents = ctx.db.listAgents();
      const allBindings = ctx.db.listBindings();
      const currentBindingCount = allBindings.filter((b) => b.agentName === agentName).length;
      const nextBindingCount = currentBindingCount - 1;
      const roleAfterMutation = resolveAgentRole({
        metadata: agent.metadata,
        bindingCount: nextBindingCount,
      });

      if (roleAfterMutation === "speaker" && nextBindingCount < 1) {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          "Cannot unbind the last adapter from speaker agent. Bind another adapter or change role to leader with `hiboss agent set`."
        );
      }

      const prediction = predictRoleAfterBindingMutation({
        agent,
        bindingCountDelta: -1,
        allAgents,
        allBindings,
      });
      if (prediction.breaking) {
        const message = buildMutationInvariantViolationMessage({
          operation: "unbind",
          agentName,
          prediction,
        });
        rpcError(RPC_ERRORS.INVALID_PARAMS, message);
      }

      // Remove adapter
      await ctx.removeAdapter(binding.adapterToken);

      // Delete binding
      ctx.db.deleteBinding(agentName, p.adapterType);

      return { success: true };
    },

    "agent.refresh": async (params) => {
      const p = params as unknown as AgentRefreshParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("agent.refresh", principal);

      // Check if agent exists
      const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName);
      if (!agent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }

      // Refresh the session
      ctx.executor.requestSessionRefresh(agent.name, "rpc:agent.refresh");

      return { success: true, agentName: agent.name };
    },

    "agent.self": async (params) => {
      const p = params as unknown as AgentSelfParams;
      const agent = ctx.db.findAgentByToken(p.token);
      if (!agent) {
        rpcError(RPC_ERRORS.UNAUTHORIZED, "Invalid token");
      }

      ctx.db.updateAgentLastSeen(agent.name);

      const provider = agent.provider ?? DEFAULT_AGENT_PROVIDER;
      const workspace = agent.workspace ?? getDefaultRuntimeWorkspace();
      const reasoningEffort = agent.reasoningEffort;

      return {
        agent: {
          name: agent.name,
          provider,
          workspace,
          model: agent.model,
          reasoningEffort,
        },
      };
    },

    "agent.session-policy.set": async (params) => {
      const p = params as unknown as AgentSessionPolicySetParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("agent.session-policy.set", principal);

      const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName);
      if (!agent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }

      const clear = p.clear === true;

      const hasAnyUpdate =
        p.sessionDailyResetAt !== undefined ||
        p.sessionIdleTimeout !== undefined ||
        p.sessionMaxContextLength !== undefined;

      if (!clear && !hasAnyUpdate) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "No session policy values provided");
      }

      let dailyResetAt: string | undefined;
      if (p.sessionDailyResetAt !== undefined) {
        if (typeof p.sessionDailyResetAt !== "string") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-daily-reset-at");
        }
        dailyResetAt = parseDailyResetAt(p.sessionDailyResetAt).normalized;
      }

      let idleTimeout: string | undefined;
      if (p.sessionIdleTimeout !== undefined) {
        if (typeof p.sessionIdleTimeout !== "string") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-idle-timeout");
        }
        parseDurationToMs(p.sessionIdleTimeout);
        idleTimeout = p.sessionIdleTimeout.trim();
      }

      let maxContextLength: number | undefined;
      if (p.sessionMaxContextLength !== undefined) {
        if (typeof p.sessionMaxContextLength !== "number" || !Number.isFinite(p.sessionMaxContextLength)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-max-context-length");
        }
        if (p.sessionMaxContextLength <= 0) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-max-context-length (must be > 0)");
        }
        maxContextLength = Math.trunc(p.sessionMaxContextLength);
      }

      const updated = ctx.db.updateAgentSessionPolicy(agent.name, {
        clear,
        dailyResetAt,
        idleTimeout,
        maxContextLength,
      });

      return { success: true, agentName: agent.name, sessionPolicy: updated.sessionPolicy };
    },
  };
}
