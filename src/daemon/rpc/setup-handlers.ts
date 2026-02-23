/**
 * Setup and admin verification RPC handlers.
 */

import type { RpcMethodRegistry, AdminVerifyParams } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import { rpcError } from "./context.js";
import {
  getSpeakerBindingIntegrity,
  toSpeakerBindingIntegrityView,
} from "../../shared/speaker-binding-invariant.js";

/**
 * Create setup RPC handlers.
 */
export function createSetupHandlers(ctx: DaemonContext): RpcMethodRegistry {
  return {
    "setup.check": async () => {
      const completed = ctx.db.isSetupComplete();
      const agents = ctx.db.listAgents();
      const bindings = ctx.db.listBindings();
      const roleCounts = ctx.db.getAgentRoleCounts();
      const missingRoles: Array<"speaker" | "leader"> = [];
      if (roleCounts.speaker < 1) missingRoles.push("speaker");
      if (roleCounts.leader < 1) missingRoles.push("leader");
      const integrityView = toSpeakerBindingIntegrityView(
        getSpeakerBindingIntegrity({
          agents,
          bindings,
        })
      );

      const bossName = (ctx.db.getBossName() ?? "").trim();
      const bossTimezone = (ctx.db.getConfig("boss_timezone") ?? "").trim();
      const telegramBossId = (ctx.db.getAdapterBossIds("telegram")[0] ?? "").trim();
      const wechatpadproBossId = (ctx.db.getAdapterBossIds("wechatpadpro")[0] ?? "").trim();
      const hasAdminToken = Boolean((ctx.db.getConfig("admin_token_hash") ?? "").trim());
      const hasChannelBossId = telegramBossId.length > 0 || wechatpadproBossId.length > 0;
      const missingUserInfo = {
        bossName: bossName.length === 0,
        bossTimezone: bossTimezone.length === 0,
        channelBossId: !hasChannelBossId,
        adminToken: !hasAdminToken,
      };
      const hasMissingUserInfo = Object.values(missingUserInfo).some(Boolean);
      const hasIntegrityViolations =
        integrityView.speakerWithoutBindings.length > 0 ||
        integrityView.duplicateSpeakerBindings.length > 0;

      return {
        completed,
        ready:
          completed &&
          missingRoles.length === 0 &&
          !hasMissingUserInfo &&
          !hasIntegrityViolations,
        roleCounts,
        missingRoles,
        integrity: integrityView,
        agents: agents.map((agent) => ({
          name: agent.name,
          role: agent.role,
          workspace: agent.workspace,
          provider: agent.provider,
        })),
        userInfo: {
          bossName: bossName || undefined,
          bossTimezone: bossTimezone || undefined,
          channelBossIds: {
            ...(telegramBossId ? { telegram: telegramBossId } : {}),
            ...(wechatpadproBossId ? { wechatpadpro: wechatpadproBossId } : {}),
          },
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
