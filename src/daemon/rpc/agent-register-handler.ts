import type { RpcMethodHandler, AgentRegisterParams } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import type { Agent } from "../../agent/types.js";
import { isValidAgentName, AGENT_NAME_ERROR_MESSAGE } from "../../shared/validation.js";
import { parseDailyResetAt, parseDurationToMs } from "../../shared/session-policy.js";
import { setupAgentHome } from "../../agent/home-setup.js";
import {
  BACKGROUND_AGENT_NAME,
  getDefaultAgentDescription,
} from "../../shared/defaults.js";
import { isPermissionLevel } from "../../shared/permissions.js";
import { isAgentRole } from "../../shared/agent-role.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";
import { generateToken } from "../../agent/auth.js";
import { mutateSettingsAndSync } from "../settings-sync.js";

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
      if (p.name.trim().toLowerCase() === BACKGROUND_AGENT_NAME) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, `Reserved agent name: ${BACKGROUND_AGENT_NAME}`);
      }

      // Check if agent already exists (case-insensitive)
      const existing = ctx.db.getAgentByNameCaseInsensitive(p.name);
      if (existing) {
        rpcError(RPC_ERRORS.ALREADY_EXISTS, "Agent already exists");
      }

      if (p.provider !== "claude" && p.provider !== "codex") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid provider (expected claude or codex)");
      }
      const provider: "claude" | "codex" = p.provider;

      if (!isAgentRole(p.role)) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid role (expected speaker or leader)");
      }
      const role: "speaker" | "leader" = p.role;
      if (p.dryRun !== undefined && typeof p.dryRun !== "boolean") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid dry-run");
      }
      const isDryRun = Boolean(p.dryRun);

      const bindAdapterType = p.bindAdapterType;
      const bindAdapterToken = p.bindAdapterToken;
      const wantsBind = bindAdapterType !== undefined || bindAdapterToken !== undefined;

      if (role === "speaker" && !wantsBind) {
        rpcError(
          RPC_ERRORS.INVALID_PARAMS,
          "Speaker agents must be bound to at least one adapter at registration."
        );
      }

      if (wantsBind) {
        if (typeof bindAdapterType !== "string" || !bindAdapterType.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid bind-adapter-type");
        }
        if (typeof bindAdapterToken !== "string" || !bindAdapterToken.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid bind-adapter-token");
        }
      }

      const normalizedBind =
        wantsBind && typeof bindAdapterType === "string" && typeof bindAdapterToken === "string"
          ? {
              adapterType: bindAdapterType.trim(),
              adapterToken: bindAdapterToken.trim(),
            }
          : undefined;

      if (normalizedBind && normalizedBind.adapterType !== "telegram") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, `Unknown adapter type: ${normalizedBind.adapterType}`);
      }

      if (normalizedBind) {
        const existingBinding = ctx.db.getBindingByAdapter(
          normalizedBind.adapterType,
          normalizedBind.adapterToken
        );
        if (existingBinding) {
          rpcError(
            RPC_ERRORS.ALREADY_EXISTS,
            `This ${normalizedBind.adapterType} bot is already bound to agent '${existingBinding.agentName}'`
          );
        }
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
        if (!isPermissionLevel(p.permissionLevel)) {
          rpcError(
            RPC_ERRORS.INVALID_PARAMS,
            "Invalid permission-level (expected restricted, standard, privileged, admin)"
          );
        }
        if (p.permissionLevel === "admin" && principal.level !== "admin") {
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

      if (isDryRun) {
        const normalizedName = p.name.trim();
        const normalizedDescription =
          typeof p.description === "string"
            ? p.description
            : getDefaultAgentDescription(normalizedName);
        const normalizedWorkspace = typeof p.workspace === "string" ? p.workspace : undefined;

        logEvent("info", "agent-register", {
          actor: principal.kind,
          "agent-name": normalizedName,
          state: "dry-run",
          "duration-ms": Date.now() - startedAtMs,
        });

        return {
          dryRun: true,
          agent: {
            name: normalizedName,
            role,
            description: normalizedDescription,
            workspace: normalizedWorkspace,
            createdAt: Date.now(),
          },
        };
      }

      // Setup agent home directory first.
      await setupAgentHome(p.name, ctx.config.dataDir);

      let createdAdapterForRegister = false;
      if (normalizedBind && ctx.running) {
        const hadAdapterAlready = ctx.adapters.has(normalizedBind.adapterToken);
        const adapter = await ctx.createAdapterForBinding(
          normalizedBind.adapterType,
          normalizedBind.adapterToken
        );
        if (!adapter) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, `Unknown adapter type: ${normalizedBind.adapterType}`);
        }
        createdAdapterForRegister = !hadAdapterAlready;
      }

      const generatedToken = generateToken();
      try {
        await mutateSettingsAndSync({
          hibossDir: ctx.config.dataDir,
          db: ctx.db,
          mutate: (settings) => {
            const exists = settings.agents.some((agent) => agent.name.toLowerCase() === p.name.trim().toLowerCase());
            if (exists) {
              rpcError(RPC_ERRORS.ALREADY_EXISTS, "Agent already exists");
            }

            settings.agents.push({
              name: p.name.trim(),
              token: generatedToken,
              role,
              provider,
              description:
                typeof p.description === "string"
                  ? p.description
                  : getDefaultAgentDescription(p.name.trim()),
              workspace:
                typeof p.workspace === "string" && p.workspace.trim()
                  ? p.workspace.trim()
                  : null,
              model: typeof p.model === "string" && p.model.trim() ? p.model.trim() : null,
              reasoningEffort: reasoningEffort ?? null,
              permissionLevel: permissionLevel ?? "standard",
              sessionPolicy: Object.keys(sessionPolicy).length > 0 ? (sessionPolicy as any) : undefined,
              metadata,
              bindings: normalizedBind ? [normalizedBind] : [],
            });
          },
        });
      } catch (err) {
        if (createdAdapterForRegister && normalizedBind) {
          await ctx.removeAdapter(normalizedBind.adapterToken).catch(() => undefined);
        }
        throw err;
      }

      // Register agent handler for auto-execution
      ctx.registerAgentHandler(p.name);

      logEvent("info", "agent-register", {
        actor: principal.kind,
        "agent-name": p.name.trim(),
        state: "success",
        "duration-ms": Date.now() - startedAtMs,
      });

      return {
        agent: {
          name: p.name.trim(),
          role,
          description:
            typeof p.description === "string"
              ? p.description
              : getDefaultAgentDescription(p.name.trim()),
          workspace: typeof p.workspace === "string" && p.workspace.trim() ? p.workspace.trim() : undefined,
          createdAt: Date.now(),
        },
        token: generatedToken,
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
