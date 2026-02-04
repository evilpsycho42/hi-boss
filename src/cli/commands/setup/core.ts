import * as path from "path";
import { IpcClient } from "../../ipc-client.js";
import { getSocketPath, getDefaultConfig, isDaemonRunning } from "../../../daemon/daemon.js";
import { HiBossDatabase } from "../../../daemon/db/database.js";
import { setupAgentHome } from "../../../agent/home-setup.js";
import type { SetupCheckResult, SetupExecuteResult } from "../../../daemon/ipc/types.js";
import type { ResolvedMemoryModelConfig } from "../../memory-model.js";
import type { SetupConfig } from "./types.js";

export function normalizeMemoryConfig(config: SetupConfig): ResolvedMemoryModelConfig {
  return (
    config.memory ?? {
      enabled: false,
      mode: "default",
      modelPath: "",
      modelUri: "",
      dims: 0,
      lastError: "Memory model is not configured",
    }
  );
}

/**
 * Check if setup is complete (tries IPC first, falls back to direct DB).
 */
export async function checkSetupStatus(): Promise<boolean> {
  // Try IPC first (daemon running)
  try {
    const client = new IpcClient(getSocketPath());
    const result = await client.call<SetupCheckResult>("setup.check");
    return result.completed;
  } catch (err) {
    if (await isDaemonRunning()) {
      throw new Error(`Failed to check setup via daemon: ${(err as Error).message}`);
    }

    // Daemon not running, check database directly
    const config = getDefaultConfig();
    const dbPath = path.join(config.dataDir, "hiboss.db");
    const db = new HiBossDatabase(dbPath);
    try {
      return db.isSetupComplete();
    } finally {
      db.close();
    }
  }
}

/**
 * Execute setup (tries IPC first, falls back to direct DB).
 */
export async function executeSetup(config: SetupConfig): Promise<string> {
  const memory = normalizeMemoryConfig(config);

  // Try IPC first (daemon running)
  try {
    const client = new IpcClient(getSocketPath());
    const result = await client.call<SetupExecuteResult>("setup.execute", {
      provider: config.provider,
      providerSourceHome: config.providerSourceHome,
      bossName: config.bossName,
      bossTimezone: config.bossTimezone,
      agent: config.agent,
      bossToken: config.bossToken,
      adapter: config.adapter,
      memory,
    });
    return result.agentToken;
  } catch (err) {
    if (await isDaemonRunning()) {
      throw new Error(`Failed to run setup via daemon: ${(err as Error).message}`);
    }

    // Daemon not running, execute directly on database
    return executeSetupDirect(config);
  }
}

function writeMemoryConfigToDb(db: HiBossDatabase, memory: ResolvedMemoryModelConfig): void {
  db.setConfig("memory_enabled", memory.enabled ? "true" : "false");
  db.setConfig("memory_model_source", memory.mode);
  db.setConfig("memory_model_uri", memory.modelUri ?? "");
  db.setConfig("memory_model_path", memory.modelPath ?? "");
  db.setConfig("memory_model_dims", String(memory.dims ?? 0));
  db.setConfig("memory_model_last_error", memory.lastError ?? "");
}

/**
 * Execute setup directly on the database (when daemon is not running).
 */
async function executeSetupDirect(config: SetupConfig): Promise<string> {
  const daemonConfig = getDefaultConfig();
  const dbPath = path.join(daemonConfig.dataDir, "hiboss.db");
  const db = new HiBossDatabase(dbPath);

  try {
    // Check if setup is already complete
    if (db.isSetupComplete()) {
      throw new Error("Setup already completed");
    }

    // Setup agent home directories
    await setupAgentHome(config.agent.name, daemonConfig.dataDir, {
      provider: config.provider,
      providerSourceHome: config.providerSourceHome,
    });

    const memory = normalizeMemoryConfig(config);

    const result = db.runInTransaction(() => {
      // Set boss name
      db.setBossName(config.bossName);

      // Set boss timezone
      db.setConfig("boss_timezone", config.bossTimezone);

      // Set default provider
      db.setDefaultProvider(config.provider);

      writeMemoryConfigToDb(db, memory);

      // Create the first agent
      const agentResult = db.registerAgent({
        name: config.agent.name,
        description: config.agent.description,
        workspace: config.agent.workspace,
        provider: config.provider,
        model: config.agent.model,
        reasoningEffort: config.agent.reasoningEffort,
        autoLevel: config.agent.autoLevel,
        permissionLevel: config.agent.permissionLevel,
        sessionPolicy: config.agent.sessionPolicy,
        metadata: config.agent.metadata,
      });

      // Create adapter binding if provided
      db.createBinding(config.agent.name, config.adapter.adapterType, config.adapter.adapterToken);

      // Store boss ID for this adapter
      db.setAdapterBossId(config.adapter.adapterType, config.adapter.adapterBossId);

      // Set boss token
      db.setBossToken(config.bossToken);

      // Mark setup as complete
      db.markSetupComplete();

      return agentResult;
    });

    return result.token;
  } finally {
    db.close();
  }
}
