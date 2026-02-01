/**
 * Agent management RPC handlers.
 *
 * Handles: agent.register, agent.list, agent.bind, agent.unbind,
 * agent.refresh, agent.self, agent.session-policy.set
 */

import type {
  RpcMethodRegistry,
  AgentRegisterParams,
  AgentBindParams,
  AgentUnbindParams,
  AgentRefreshParams,
  AgentSelfParams,
  AgentSessionPolicySetParams,
} from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import type { Agent } from "../../agent/types.js";
import { isValidAgentName, AGENT_NAME_ERROR_MESSAGE } from "../../shared/validation.js";
import { parseDailyResetAt, parseDurationToMs } from "../../shared/session-policy.js";
import { setupAgentHome } from "../../agent/home-setup.js";
import {
  DEFAULT_AGENT_AUTO_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_REASONING_EFFORT,
} from "../../shared/defaults.js";

/**
 * Create agent RPC handlers (excluding agent.set which is in its own file).
 */
export function createAgentHandlers(ctx: DaemonContext): RpcMethodRegistry {
  return {
    "agent.register": async (params) => {
      const p = params as unknown as AgentRegisterParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("agent.register", principal);

      if (typeof p.name !== "string" || !isValidAgentName(p.name)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, AGENT_NAME_ERROR_MESSAGE);
      }

      // Check if agent already exists (case-insensitive)
      const existing = ctx.db.getAgentByNameCaseInsensitive(p.name);
      if (existing) {
        rpcError(RPC_ERRORS.ALREADY_EXISTS, "Agent already exists");
      }

      let provider: "claude" | "codex" | undefined;
      if (p.provider !== undefined) {
        if (p.provider !== "claude" && p.provider !== "codex") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid provider (expected claude or codex)");
        }
        provider = p.provider;
      }

      let reasoningEffort: Agent["reasoningEffort"] | undefined;
      if (p.reasoningEffort !== undefined) {
        if (
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

      let autoLevel: Agent["autoLevel"] | undefined;
      if (p.autoLevel !== undefined) {
        if (p.autoLevel !== "medium" && p.autoLevel !== "high") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid auto-level (expected medium, high)");
        }
        autoLevel = p.autoLevel;
      }

      let permissionLevel: "restricted" | "standard" | "privileged" | undefined;
      if (p.permissionLevel !== undefined) {
        if (
          p.permissionLevel !== "restricted" &&
          p.permissionLevel !== "standard" &&
          p.permissionLevel !== "privileged"
        ) {
          rpcError(
            RPC_ERRORS.INVALID_PARAMS,
            "Invalid permission-level (expected restricted, standard, privileged)"
          );
        }
        permissionLevel = p.permissionLevel;
      }

      let metadata: Record<string, unknown> | undefined;
      if (p.metadata !== undefined) {
        if (typeof p.metadata !== "object" || p.metadata === null || Array.isArray(p.metadata)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid metadata (expected object)");
        }
        metadata = p.metadata;
      }

      const sessionPolicy: Record<string, unknown> = {};
      if (p.sessionDailyResetAt !== undefined) {
        if (typeof p.sessionDailyResetAt !== "string") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-daily-reset-at");
        }
        sessionPolicy.dailyResetAt = parseDailyResetAt(p.sessionDailyResetAt).normalized;
      }
      if (p.sessionIdleTimeout !== undefined) {
        if (typeof p.sessionIdleTimeout !== "string") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-idle-timeout");
        }
        // Validate duration; store original (trimmed) for readability.
        parseDurationToMs(p.sessionIdleTimeout);
        sessionPolicy.idleTimeout = p.sessionIdleTimeout.trim();
      }
      if (p.sessionMaxTokens !== undefined) {
        if (typeof p.sessionMaxTokens !== "number" || !Number.isFinite(p.sessionMaxTokens)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-max-tokens");
        }
        if (p.sessionMaxTokens <= 0) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-max-tokens (must be > 0)");
        }
        sessionPolicy.maxTokens = Math.trunc(p.sessionMaxTokens);
      }

      const result = ctx.db.registerAgent({
        name: p.name,
        description: p.description,
        workspace: p.workspace,
        provider,
        model: typeof p.model === "string" && p.model.trim() ? p.model.trim() : undefined,
        reasoningEffort,
        autoLevel,
        permissionLevel,
        sessionPolicy: Object.keys(sessionPolicy).length > 0 ? sessionPolicy as any : undefined,
        metadata,
      });

      // Setup agent home directories
      await setupAgentHome(p.name, ctx.config.dataDir);

      const bindAdapterType = p.bindAdapterType;
      const bindAdapterToken = p.bindAdapterToken;
      const wantsBind = bindAdapterType !== undefined || bindAdapterToken !== undefined;

      if (wantsBind) {
        if (typeof bindAdapterType !== "string" || !bindAdapterType.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid bind-adapter-type");
        }
        if (typeof bindAdapterToken !== "string" || !bindAdapterToken.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid bind-adapter-token");
        }

        const adapterType = bindAdapterType.trim();
        const adapterToken = bindAdapterToken.trim();

        const existingBinding = ctx.db.getBindingByAdapter(adapterType, adapterToken);
        if (existingBinding) {
          rpcError(
            RPC_ERRORS.ALREADY_EXISTS,
            `This ${adapterType} bot is already bound to agent '${existingBinding.agentName}'`
          );
        }

        const agentBinding = ctx.db.getAgentBindingByType(p.name, adapterType);
        if (agentBinding) {
          rpcError(RPC_ERRORS.ALREADY_EXISTS, `Agent '${p.name}' already has a ${adapterType} binding`);
        }

        const hadAdapterAlready = ctx.adapters.has(adapterToken);
        let createdAdapterForRegister = false;

        if (ctx.running) {
          try {
            const adapter = await ctx.createAdapterForBinding(adapterType, adapterToken);
            if (!adapter) {
              rpcError(RPC_ERRORS.INVALID_PARAMS, `Unknown adapter type: ${adapterType}`);
            }
            createdAdapterForRegister = !hadAdapterAlready;
          } catch (err) {
            if (!hadAdapterAlready) {
              await ctx.removeAdapter(adapterToken).catch(() => undefined);
            }
            throw err;
          }
        }

        try {
          ctx.db.createBinding(p.name, adapterType, adapterToken);
        } catch (err) {
          if (createdAdapterForRegister) {
            await ctx.removeAdapter(adapterToken).catch(() => undefined);
          }
          throw err;
        }
      }

      // Register agent handler for auto-execution
      ctx.registerAgentHandler(p.name);

      return {
        agent: {
          name: result.agent.name,
          description: result.agent.description,
          workspace: result.agent.workspace,
          createdAt: result.agent.createdAt,
        },
        token: result.token,
      };
    },

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
      const reasoningEffort = agent.reasoningEffort ?? DEFAULT_AGENT_REASONING_EFFORT;
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
        p.sessionMaxTokens !== undefined;

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

      let maxTokens: number | undefined;
      if (p.sessionMaxTokens !== undefined) {
        if (typeof p.sessionMaxTokens !== "number" || !Number.isFinite(p.sessionMaxTokens)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-max-tokens");
        }
        if (p.sessionMaxTokens <= 0) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-max-tokens (must be > 0)");
        }
        maxTokens = Math.trunc(p.sessionMaxTokens);
      }

      const updated = ctx.db.updateAgentSessionPolicy(agent.name, {
        clear,
        dailyResetAt,
        idleTimeout,
        maxTokens,
      });

      return { success: true, agentName: agent.name, sessionPolicy: updated.sessionPolicy };
    },
  };
}
