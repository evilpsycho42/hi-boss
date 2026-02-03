/**
 * Create agent.delete RPC handler.
 */

import type { RpcMethodRegistry, AgentDeleteParams, AgentDeleteResult } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken, rpcError } from "./context.js";
import { removeAgentHome } from "../../agent/home-setup.js";

function deleteAgentRow(ctx: DaemonContext, agentName: string): boolean {
  const rawDb = (ctx.db as any).db as { prepare: (sql: string) => { run: (...args: any[]) => { changes: number } } };
  if (!rawDb || typeof rawDb.prepare !== "function") {
    rpcError(RPC_ERRORS.INTERNAL_ERROR, "Database handle unavailable");
  }

  const info = rawDb.prepare("DELETE FROM agents WHERE name = ?").run(agentName);
  return info.changes > 0;
}

export function createAgentDeleteHandler(ctx: DaemonContext): RpcMethodRegistry {
  return {
    "agent.delete": async (params): Promise<AgentDeleteResult> => {
      const p = params as unknown as AgentDeleteParams;
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("agent.delete", principal);

      if (typeof p.agentName !== "string" || !p.agentName.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid agentName");
      }

      const agent = ctx.db.getAgentByNameCaseInsensitive(p.agentName.trim());
      if (!agent) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }

      // Best-effort: stop routing and close the runtime session before deleting on disk.
      ctx.router.unregisterAgentHandler(agent.name);
      await ctx.executor.refreshSession(agent.name, "agent-delete").catch(() => undefined);

      // Capture bindings for cleanup (adapter removal) before deleting.
      const bindings = ctx.db.getBindingsByAgentName(agent.name);

      const deleted = ctx.db.runInTransaction(() => {
        // Delete cron schedules (cancel pending envelopes to avoid scheduler retry loops).
        const schedules = ctx.db.listCronSchedulesByAgent(agent.name);
        for (const schedule of schedules) {
          if (schedule.pendingEnvelopeId) {
            ctx.db.updateEnvelopeStatus(schedule.pendingEnvelopeId, "done");
          }
          ctx.db.deleteCronSchedule(schedule.id);
        }

        // Delete bindings.
        for (const binding of bindings) {
          ctx.db.deleteBinding(agent.name, binding.adapterType);
        }

        // Finally, delete the agent row.
        return deleteAgentRow(ctx, agent.name);
      });

      if (!deleted) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
      }

      // Best-effort: remove loaded adapters for any deleted bindings.
      for (const binding of bindings) {
        await ctx.removeAdapter(binding.adapterToken).catch(() => undefined);
      }

      // Best-effort: remove agent home directories.
      try {
        removeAgentHome(agent.name, ctx.config.dataDir);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[agent.delete] failed to remove home for ${agent.name}: ${message}`);
      }

      return { success: true, agentName: agent.name };
    },
  };
}
