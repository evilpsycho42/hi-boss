/**
 * Daemon status and ping RPC handlers.
 */

import type { RpcMethodRegistry } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { requireToken } from "./context.js";

/**
 * Create daemon RPC handlers.
 */
export function createDaemonHandlers(ctx: DaemonContext): RpcMethodRegistry {
  return {
    "daemon.status": async (params) => {
      const p = params as unknown as { token: string };
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("daemon.status", principal);

      const bindings = ctx.db.listBindings();
      return {
        running: ctx.running,
        startTimeMs: typeof ctx.startTimeMs === "number" ? ctx.startTimeMs : undefined,
        adapters: Array.from(ctx.adapters.values()).map((a) => a.platform),
        bindings: bindings.map((b) => ({
          agentName: b.agentName,
          adapterType: b.adapterType,
        })),
        dataDir: ctx.config.dataDir,
      };
    },

    "daemon.ping": async (params) => {
      const p = params as unknown as { token: string };
      const token = requireToken(p.token);
      const principal = ctx.resolvePrincipal(token);
      ctx.assertOperationAllowed("daemon.ping", principal);

      return { pong: true, timestampMs: Date.now() };
    },
  };
}
