import type { RpcMethodHandler, AgentRegisterParams } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import type { Agent } from "../../agent/types.js";
import { isValidAgentName, AGENT_NAME_ERROR_MESSAGE } from "../../shared/validation.js";
import { parseDailyResetAt, parseDurationToMs } from "../../shared/session-policy.js";
import { setupAgentHome } from "../../agent/home-setup.js";
import { DEFAULT_AGENT_PROVIDER } from "../../shared/defaults.js";
import { isPermissionLevel } from "../../shared/permissions.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";

export function createAgentRegisterHandler(ctx: DaemonContext): RpcMethodHandler {
  return async (params) => {
    const p = params as unknown as AgentRegisterParams;
    const token = requireToken(p.token);
    const principal = ctx.resolvePrincipal(token);
    ctx.assertOperationAllowed("agent.register", principal);

    const startedAtMs = Date.now();
    const requestedAgentName = typeof p.name === "string" ? p.name.trim() : "";

    try {
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

      let autoLevel: Agent["autoLevel"] | undefined;
      if (p.autoLevel !== undefined) {
        if (p.autoLevel !== "medium" && p.autoLevel !== "high") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid auto-level (expected medium, high)");
        }
        autoLevel = p.autoLevel;
      }

      let permissionLevel: Agent["permissionLevel"] | undefined;
      if (p.permissionLevel !== undefined) {
        if (!isPermissionLevel(p.permissionLevel)) {
          rpcError(
            RPC_ERRORS.INVALID_PARAMS,
            "Invalid permission-level (expected restricted, standard, privileged, boss)"
          );
        }
        if (p.permissionLevel === "boss" && principal.level !== "boss") {
          rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
        }
        permissionLevel = p.permissionLevel;
      }

      let metadata: Record<string, unknown> | undefined;
      if (p.metadata !== undefined) {
        if (typeof p.metadata !== "object" || p.metadata === null || Array.isArray(p.metadata)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid metadata (expected object)");
        }
        const copy = { ...(p.metadata as Record<string, unknown>) };
        // Reserved internal metadata key (best-effort session resume handle).
        delete copy.sessionHandle;
        metadata = copy;
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
      if (p.sessionMaxContextLength !== undefined) {
        if (
          typeof p.sessionMaxContextLength !== "number" ||
          !Number.isFinite(p.sessionMaxContextLength)
        ) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-max-context-length");
        }
        if (p.sessionMaxContextLength <= 0) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-max-context-length (must be > 0)");
        }
        sessionPolicy.maxContextLength = Math.trunc(p.sessionMaxContextLength);
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
        sessionPolicy: Object.keys(sessionPolicy).length > 0 ? (sessionPolicy as any) : undefined,
        metadata,
      });

      // Setup agent home directories
      let providerSourceHome: string | undefined;
      if (p.providerSourceHome !== undefined) {
        if (typeof p.providerSourceHome !== "string" || !p.providerSourceHome.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid provider-source-home");
        }
        providerSourceHome = p.providerSourceHome.trim();
      }

      const effectiveProvider = provider ?? DEFAULT_AGENT_PROVIDER;
      try {
        await setupAgentHome(p.name, ctx.config.dataDir, {
          provider: effectiveProvider,
          providerSourceHome,
        });
      } catch (err) {
        const message = (err as Error).message || String(err);
        if (message.includes("provider-source-home")) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, message);
        }
        throw err;
      }

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
          rpcError(
            RPC_ERRORS.ALREADY_EXISTS,
            `Agent '${p.name}' already has a ${adapterType} binding`
          );
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

      logEvent("info", "agent-register", {
        actor: principal.kind,
        "agent-name": result.agent.name,
        state: "success",
        "duration-ms": Date.now() - startedAtMs,
      });

      return {
        agent: {
          name: result.agent.name,
          description: result.agent.description,
          workspace: result.agent.workspace,
          createdAt: result.agent.createdAt,
        },
        token: result.token,
      };
    } catch (err) {
      logEvent("info", "agent-register", {
        actor: principal.kind,
        "agent-name": requestedAgentName || undefined,
        state: "failed",
        "duration-ms": Date.now() - startedAtMs,
        error: errorMessage(err),
      });
      throw err;
    }
  };
}

