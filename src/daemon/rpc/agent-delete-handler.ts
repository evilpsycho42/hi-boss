/**
 * Create agent.delete RPC handler.
 */

import type { RpcMethodRegistry, AgentDeleteParams, AgentDeleteResult } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import { removeAgentHome } from "../../agent/home-setup.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";
import { mutateSettingsAndSync } from "../settings-sync.js";

export function createAgentDeleteHandler(ctx: DaemonContext): RpcMethodRegistry {
  return {
    "agent.delete": async (params): Promise<AgentDeleteResult> => {
      const p = params as unknown as AgentDeleteParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("agent.delete", principal);

      const startedAtMs = Date.now();
      const requestedAgentName = typeof p.agentName === "string" ? p.agentName.trim() : "";

      try {
        if (typeof p.agentName !== "string" || !p.agentName.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid agentName");
        }

        const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName.trim());
        if (!agent) {
          rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
        }

        // Best-effort: close the runtime session before deleting on disk.
        await ctx.executor.refreshSession(agent.name, "agent-delete").catch(() => undefined);

        // Capture bindings for cleanup (adapter removal) before deleting.
        const bindings = ctx.db.getBindingsByAgentName(agent.name);

        await mutateSettingsAndSync({
          hibossDir: ctx.config.dataDir,
          db: ctx.db,
          mutate: (settings) => {
            settings.agents = settings.agents.filter(
              (item) => item.name.toLowerCase() !== agent.name.toLowerCase()
            );
          },
        });

        // Stop routing after deletion is committed.
        ctx.router.unregisterAgentHandler(agent.name);

        // Best-effort: remove loaded adapters for any deleted bindings.
        for (const binding of bindings) {
          await ctx.removeAdapter(binding.adapterToken).catch(() => undefined);
        }

        // Best-effort: remove agent home directories.
        try {
          removeAgentHome(agent.name, ctx.config.dataDir);
        } catch (err) {
          logEvent("warn", "agent-home-remove-failed", {
            "agent-name": agent.name,
            error: errorMessage(err),
          });
        }

        logEvent("info", "agent-delete", {
          actor: principal.kind,
          "agent-name": agent.name,
          state: "success",
          "duration-ms": Date.now() - startedAtMs,
        });

        return { success: true, agentName: agent.name };
      } catch (err) {
        logEvent("info", "agent-delete", {
          actor: principal.kind,
          "agent-name": requestedAgentName || undefined,
          state: "failed",
          "duration-ms": Date.now() - startedAtMs,
          error: errorMessage(err),
        });
        throw err;
      }
    },
  };
}
