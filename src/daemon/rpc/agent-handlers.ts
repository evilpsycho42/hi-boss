/**
 * Agent management RPC handlers.
 *
 * Handles: agent.register, agent.list, agent.bind, agent.unbind,
 * agent.refresh, agent.self, agent.session-policy.set, agent.status
 */

import type {
  RpcMethodRegistry,
  AgentBindParams,
  AgentUnbindParams,
  AgentRefreshParams,
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
  DEFAULT_AGENT_AUTO_LEVEL,
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
} from "../../shared/defaults.js";
import { createAgentRegisterHandler } from "./agent-register-handler.js";

/**
 * Create agent RPC handlers (excluding agent.set which is in its own file).
 */
export function createAgentHandlers(ctx: DaemonContext): RpcMethodRegistry {
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
          description: a.description,
          workspace: a.workspace,
          provider: a.provider,
          model: a.model,
          reasoningEffort: a.reasoningEffort,
          autoLevel: a.autoLevel,
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
      const effectiveAutoLevel = agent.autoLevel ?? DEFAULT_AGENT_AUTO_LEVEL;
      const effectivePermissionLevel = agent.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL;
      const effectiveWorkspace = agent.workspace ?? process.cwd();

      const isBusy = ctx.executor.isAgentBusy(agent.name);
      const pendingCount = ctx.db.countDuePendingEnvelopesForAgent(agent.name);
      const bindings = ctx.db.getBindingsByAgentName(agent.name).map((b) => b.adapterType);

      const currentRun = isBusy ? ctx.db.getCurrentRunningAgentRun(agent.name) : null;
      const lastRun = ctx.db.getLastFinishedAgentRun(agent.name);

      const result: AgentStatusResult = {
        agent: {
          name: agent.name,
          ...(agent.description ? { description: agent.description } : {}),
          ...(agent.workspace ? { workspace: agent.workspace } : {}),
          ...(agent.provider ? { provider: agent.provider } : {}),
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
          ...(agent.autoLevel ? { autoLevel: agent.autoLevel } : {}),
          ...(agent.permissionLevel ? { permissionLevel: agent.permissionLevel } : {}),
          ...(agent.sessionPolicy ? { sessionPolicy: agent.sessionPolicy } : {}),
        },
        bindings,
        effective: {
          workspace: effectiveWorkspace,
          provider: effectiveProvider,
          autoLevel: effectiveAutoLevel,
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
                status: lastRun.status === "failed" ? "failed" : "completed",
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
      const workspace = agent.workspace ?? process.cwd();
      const reasoningEffort = agent.reasoningEffort;
      const autoLevel = agent.autoLevel ?? DEFAULT_AGENT_AUTO_LEVEL;

      return {
        agent: {
          name: agent.name,
          provider,
          workspace,
          model: agent.model,
          reasoningEffort,
          autoLevel,
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
