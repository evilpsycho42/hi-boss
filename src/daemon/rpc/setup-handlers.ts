/**
 * Setup and admin verification RPC handlers.
 */

import type { RpcMethodRegistry, AdminVerifyParams } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { rpcError } from "./context.js";
import { parseUserPermissionPolicy } from "../../shared/user-permissions.js";

/**
 * Create setup RPC handlers.
 */
export function createSetupHandlers(ctx: DaemonContext): RpcMethodRegistry {
  return {
    "setup.check": async () => {
      const completed = ctx.db.isSetupComplete();
      const agents = ctx.db.listAgents();

      const bossName = (ctx.db.getBossName() ?? "").trim();
      const bossTimezone = (ctx.db.getConfig("boss_timezone") ?? "").trim();
      const hasAdminToken = (() => {
        const raw = (ctx.db.getConfig("user_permission_policy") ?? "").trim();
        if (!raw) return false;
        try {
          const policy = parseUserPermissionPolicy(raw);
          return policy.tokens.some((item) => item.role === "admin");
        } catch {
          return false;
        }
      })();
      const missingUserInfo = {
        bossName: bossName.length === 0,
        bossTimezone: bossTimezone.length === 0,
        adminToken: !hasAdminToken,
      };
      const hasMissingUserInfo = Object.values(missingUserInfo).some(Boolean);

      return {
        completed,
        ready:
          completed &&
          !hasMissingUserInfo,
        agents: agents.map((agent) => ({
          name: agent.name,
          workspace: agent.workspace,
          provider: agent.provider,
        })),
        userInfo: {
          bossName: bossName || undefined,
          bossTimezone: bossTimezone || undefined,
          hasAdminToken,
          missing: missingUserInfo,
        },
      };
    },

    "setup.execute": async (_params) => {
      rpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "setup.execute is deprecated. Run `hiboss setup` to generate settings.json."
      );
    },

    // Admin methods
    "admin.verify": async (params) => {
      const p = params as unknown as AdminVerifyParams;
      return { valid: ctx.db.verifyAdminToken(p.token) };
    },
  };
}
