import * as fs from "node:fs";
import * as path from "node:path";

import { IpcClient } from "../../ipc-client.js";
import { getSocketPath, getDefaultConfig, isDaemonRunning } from "../../../daemon/daemon.js";
import { HiBossDatabase } from "../../../daemon/db/database.js";
import { setupAgentHome } from "../../../agent/home-setup.js";
import type { SetupCheckResult } from "../../../daemon/ipc/types.js";
import type { SetupConfig } from "./types.js";
import { generateToken } from "../../../agent/auth.js";
import { DEFAULT_PERMISSION_POLICY } from "../../../shared/defaults.js";
import { SETTINGS_VERSION, type Settings } from "../../../shared/settings.js";
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
  agents: Array<{
    name: string;
    workspace?: string;
    provider?: "claude" | "codex";
  }>;
  userInfo: SetupUserInfoStatus;
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
    agents: [],
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
  const userInfo = buildUserInfoStatus(db);
  const hasMissingUserInfo = Object.values(userInfo.missing).some(Boolean);
  const ready =
    hasSettingsFile &&
    completed &&
    !hasMissingUserInfo;

  return {
    completed,
    ready,
    hasSettingsFile,
    agents: agents.map((agent) => ({
      name: agent.name,
      ...(agent.workspace ? { workspace: agent.workspace } : {}),
      ...(agent.provider ? { provider: agent.provider } : {}),
    })),
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

    const userInfo = result.userInfo ?? buildEmptySetupStatus().userInfo;
    const hasMissingUserInfo = Object.values(userInfo.missing).some(Boolean);
    const remoteReady =
      typeof result.ready === "boolean"
        ? result.ready
        : result.completed &&
          !hasMissingUserInfo;

    return {
      completed: result.completed,
      ready: hasSettingsFile && remoteReady,
      hasSettingsFile,
      agents: result.agents ?? [],
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
export async function executeSetup(config: SetupConfig): Promise<{ primaryAgentToken: string; secondaryAgentToken: string }> {
  if (await isDaemonRunning()) {
    throw new Error("Daemon is running. Stop it first: hiboss daemon stop --token <admin-token>");
  }
  return executeSetupDirect(config);
}

async function executeSetupDirect(config: SetupConfig): Promise<{ primaryAgentToken: string; secondaryAgentToken: string }> {
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
    // NOTE: if DB is complete but settings.json is missing, new agent tokens are generated
    // and previous tokens are invalidated (plaintext tokens are not recoverable from DB hashes).
    if (db.isSetupComplete() && hasSettingsFile) {
      throw new Error("Setup already completed");
    }
    if (db.isSetupComplete() && !hasSettingsFile) {
      console.warn(
        "Warning: settings.json is missing while DB is marked complete. New tokens will be generated; previously issued agent tokens will stop working."
      );
    }

    await setupAgentHome(config.primaryAgent.name, daemonConfig.dataDir);
    await setupAgentHome(config.secondaryAgent.name, daemonConfig.dataDir);
    ensureBossProfileFile(daemonConfig.dataDir);

    const primaryAgentToken = generateToken();
    const secondaryAgentToken = generateToken();

    const settings: Settings = {
      version: SETTINGS_VERSION,
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
          name: config.primaryAgent.name,
          token: primaryAgentToken,
          provider: config.primaryAgent.provider,
          description: config.primaryAgent.description ?? "",
          workspace: config.primaryAgent.workspace,
          model: config.primaryAgent.model ?? null,
          reasoningEffort: config.primaryAgent.reasoningEffort ?? null,
          permissionLevel: config.primaryAgent.permissionLevel ?? "standard",
          sessionPolicy: config.primaryAgent.sessionPolicy,
          metadata: config.primaryAgent.metadata,
          bindings: [
            {
              adapterType: config.adapter.adapterType,
              adapterToken: config.adapter.adapterToken,
            },
          ],
        },
        {
          name: config.secondaryAgent.name,
          token: secondaryAgentToken,
          provider: config.secondaryAgent.provider,
          description: config.secondaryAgent.description ?? "",
          workspace: config.secondaryAgent.workspace,
          model: config.secondaryAgent.model ?? null,
          reasoningEffort: config.secondaryAgent.reasoningEffort ?? null,
          permissionLevel: config.secondaryAgent.permissionLevel ?? "standard",
          sessionPolicy: config.secondaryAgent.sessionPolicy,
          metadata: config.secondaryAgent.metadata,
          bindings: [],
        },
      ],
    };

    await writeSettingsFileAtomic(daemonConfig.dataDir, settings);
    syncSettingsToDb(db, settings);

    return {
      primaryAgentToken,
      secondaryAgentToken,
    };
  } finally {
    db.close();
  }
}
