import * as fs from "node:fs";
import * as path from "node:path";

import { IpcClient } from "../../ipc-client.js";
import { getSocketPath, getDefaultConfig, isDaemonRunning } from "../../../daemon/daemon.js";
import { HiBossDatabase } from "../../../daemon/db/database.js";
import { setupAgentHome } from "../../../agent/home-setup.js";
import type { SetupCheckResult } from "../../../daemon/ipc/types.js";
import type { SetupConfig } from "./types.js";
import type { AgentRole } from "../../../shared/agent-role.js";
import {
  getSpeakerBindingIntegrity,
  toSpeakerBindingIntegrityView,
} from "../../../shared/speaker-binding-invariant.js";
import { generateToken } from "../../../agent/auth.js";
import { DEFAULT_PERMISSION_POLICY } from "../../../shared/defaults.js";
import type { SettingsV3 } from "../../../shared/settings.js";
import { getSettingsPath, writeSettingsFileAtomic } from "../../../shared/settings-io.js";
import { syncSettingsToDb } from "../../../daemon/settings-sync.js";

export interface SetupUserInfoStatus {
  bossName?: string;
  bossTimezone?: string;
  telegramBossId?: string;
  hasAdminToken: boolean;
  missing: {
    bossName: boolean;
    bossTimezone: boolean;
    telegramBossId: boolean;
    adminToken: boolean;
  };
}

export interface SetupStatus {
  completed: boolean;
  ready: boolean;
  hasSettingsFile: boolean;
  roleCounts: {
    speaker: number;
    leader: number;
  };
  missingRoles: AgentRole[];
  agents: Array<{
    name: string;
    role?: AgentRole;
    workspace?: string;
    provider?: "claude" | "codex";
  }>;
  integrity: {
    speakerWithoutBindings: string[];
    duplicateSpeakerBindings: Array<{
      adapterType: string;
      adapterTokenRedacted: string;
      speakers: string[];
    }>;
  };
  userInfo: SetupUserInfoStatus;
}

function getMissingRoles(roleCounts: { speaker: number; leader: number }): AgentRole[] {
  const missing: AgentRole[] = [];
  if (roleCounts.speaker < 1) missing.push("speaker");
  if (roleCounts.leader < 1) missing.push("leader");
  return missing;
}

function hasIntegrityViolations(integrity: SetupStatus["integrity"]): boolean {
  return (
    integrity.speakerWithoutBindings.length > 0 ||
    integrity.duplicateSpeakerBindings.length > 0
  );
}

function buildUserInfoStatus(db: HiBossDatabase): SetupUserInfoStatus {
  const bossName = (db.getBossName() ?? "").trim();
  const bossTimezone = (db.getConfig("boss_timezone") ?? "").trim();
  const telegramBossId = (db.getAdapterBossIds("telegram")[0] ?? "").trim();
  const hasAdminToken = Boolean((db.getConfig("admin_token_hash") ?? "").trim());
  return {
    bossName: bossName || undefined,
    bossTimezone: bossTimezone || undefined,
    telegramBossId: telegramBossId || undefined,
    hasAdminToken,
    missing: {
      bossName: bossName.length === 0,
      bossTimezone: bossTimezone.length === 0,
      telegramBossId: telegramBossId.length === 0,
      adminToken: !hasAdminToken,
    },
  };
}

function buildEmptySetupStatus(): SetupStatus {
  return {
    completed: false,
    ready: false,
    hasSettingsFile: false,
    roleCounts: { speaker: 0, leader: 0 },
    missingRoles: ["speaker", "leader"],
    agents: [],
    integrity: {
      speakerWithoutBindings: [],
      duplicateSpeakerBindings: [],
    },
    userInfo: {
      hasAdminToken: false,
      missing: {
        bossName: true,
        bossTimezone: true,
        telegramBossId: true,
        adminToken: true,
      },
    },
  };
}

function buildSetupStatusFromDb(db: HiBossDatabase): SetupStatus {
  const daemonConfig = getDefaultConfig();
  const hasSettingsFile = fs.existsSync(getSettingsPath(daemonConfig.dataDir));
  const completed = db.isSetupComplete();
  const agents = db.listAgents();
  const bindings = db.listBindings();
  const roleCounts = db.getAgentRoleCounts();
  const missingRoles = getMissingRoles(roleCounts);
  const integrity = toSpeakerBindingIntegrityView(
    getSpeakerBindingIntegrity({
      agents,
      bindings,
    })
  );
  const userInfo = buildUserInfoStatus(db);
  const hasMissingUserInfo = Object.values(userInfo.missing).some(Boolean);
  const ready =
    hasSettingsFile &&
    completed &&
    missingRoles.length === 0 &&
    !hasMissingUserInfo &&
    !hasIntegrityViolations(integrity);

  return {
    completed,
    ready,
    hasSettingsFile,
    roleCounts,
    missingRoles,
    agents: agents.map((agent) => ({
      name: agent.name,
      role: agent.role,
      workspace: agent.workspace,
      provider: agent.provider,
    })),
    integrity,
    userInfo,
  };
}

/**
 * Check setup health (tries IPC first, falls back to direct DB).
 */
export async function checkSetupStatus(): Promise<SetupStatus> {
  const daemonConfig = getDefaultConfig();
  const hasSettingsFile = fs.existsSync(getSettingsPath(daemonConfig.dataDir));
  try {
    const client = new IpcClient(getSocketPath());
    const result = await client.call<SetupCheckResult>("setup.check");

    const roleCounts = result.roleCounts ?? { speaker: 0, leader: 0 };
    const missingRoles = result.missingRoles ?? getMissingRoles(roleCounts);
    const userInfo = result.userInfo ?? buildEmptySetupStatus().userInfo;
    const hasMissingUserInfo = Object.values(userInfo.missing).some(Boolean);
    const integrity = result.integrity ?? {
      speakerWithoutBindings: [],
      duplicateSpeakerBindings: [],
    };
    const remoteReady =
      typeof result.ready === "boolean"
        ? result.ready
        : result.completed &&
          missingRoles.length === 0 &&
          !hasMissingUserInfo &&
          !hasIntegrityViolations(integrity);

    return {
      completed: result.completed,
      ready: hasSettingsFile && remoteReady,
      hasSettingsFile,
      roleCounts,
      missingRoles,
      agents: result.agents ?? [],
      integrity,
      userInfo,
    };
  } catch (err) {
    if (await isDaemonRunning()) {
      throw new Error(`Failed to check setup via daemon: ${(err as Error).message}`);
    }

    if (!fs.existsSync(daemonConfig.daemonDir)) {
      return buildEmptySetupStatus();
    }

    const dbPath = path.join(daemonConfig.daemonDir, "hiboss.db");
    if (!fs.existsSync(dbPath)) {
      return buildEmptySetupStatus();
    }

    const db = new HiBossDatabase(dbPath);
    try {
      return buildSetupStatusFromDb(db);
    } finally {
      db.close();
    }
  }
}

function ensureBossProfileFile(hibossDir: string): void {
  try {
    const bossMdPath = path.join(hibossDir, "BOSS.md");
    if (!fs.existsSync(bossMdPath)) {
      fs.writeFileSync(bossMdPath, "", "utf8");
      return;
    }
    const stat = fs.statSync(bossMdPath);
    if (!stat.isFile()) {
      return;
    }
  } catch {
    // Best-effort; don't fail setup on customization file issues.
  }
}

/**
 * Execute full first-time setup.
 */
export async function executeSetup(config: SetupConfig): Promise<{ speakerAgentToken: string; leaderAgentToken: string }> {
  if (await isDaemonRunning()) {
    throw new Error("Daemon is running. Stop it first: hiboss daemon stop --token <admin-token>");
  }
  return executeSetupDirect(config);
}

async function executeSetupDirect(config: SetupConfig): Promise<{ speakerAgentToken: string; leaderAgentToken: string }> {
  const daemonConfig = getDefaultConfig();
  const settingsPath = getSettingsPath(daemonConfig.dataDir);
  const hasSettingsFile = fs.existsSync(settingsPath);
  fs.mkdirSync(daemonConfig.dataDir, { recursive: true });
  fs.mkdirSync(daemonConfig.daemonDir, { recursive: true });

  const dbPath = path.join(daemonConfig.daemonDir, "hiboss.db");
  const db = new HiBossDatabase(dbPath);
  try {
    // Recovery/migration: allow setup to rewrite settings+DB when either side is missing.
    // Block only when both DB completion marker and settings file are already present.
    if (db.isSetupComplete() && hasSettingsFile) {
      throw new Error("Setup already completed");
    }

    await setupAgentHome(config.speakerAgent.name, daemonConfig.dataDir);
    await setupAgentHome(config.leaderAgent.name, daemonConfig.dataDir);
    ensureBossProfileFile(daemonConfig.dataDir);

    const speakerAgentToken = generateToken();
    const leaderAgentToken = generateToken();

    const settings: SettingsV3 = {
      version: 4,
      boss: {
        name: config.bossName,
        timezone: config.bossTimezone,
      },
      admin: {
        token: config.adminToken,
      },
      telegram: {
        bossIds: config.adapter.adapterBossIds,
      },
      permissionPolicy: DEFAULT_PERMISSION_POLICY,
      agents: [
        {
          name: config.speakerAgent.name,
          token: speakerAgentToken,
          role: "speaker",
          provider: config.speakerAgent.provider,
          description: config.speakerAgent.description ?? "",
          workspace: config.speakerAgent.workspace,
          model: config.speakerAgent.model ?? null,
          reasoningEffort: config.speakerAgent.reasoningEffort ?? null,
          permissionLevel: config.speakerAgent.permissionLevel ?? "standard",
          sessionPolicy: config.speakerAgent.sessionPolicy,
          metadata: config.speakerAgent.metadata,
          bindings: [
            {
              adapterType: config.adapter.adapterType,
              adapterToken: config.adapter.adapterToken,
            },
          ],
        },
        {
          name: config.leaderAgent.name,
          token: leaderAgentToken,
          role: "leader",
          provider: config.leaderAgent.provider,
          description: config.leaderAgent.description ?? "",
          workspace: config.leaderAgent.workspace,
          model: config.leaderAgent.model ?? null,
          reasoningEffort: config.leaderAgent.reasoningEffort ?? null,
          permissionLevel: config.leaderAgent.permissionLevel ?? "standard",
          sessionPolicy: config.leaderAgent.sessionPolicy,
          metadata: config.leaderAgent.metadata,
          bindings: [],
        },
      ],
    };

    await writeSettingsFileAtomic(daemonConfig.dataDir, settings);
    syncSettingsToDb(db, settings);

    return {
      speakerAgentToken,
      leaderAgentToken,
    };
  } finally {
    db.close();
  }
}
