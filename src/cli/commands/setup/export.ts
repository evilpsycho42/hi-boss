import * as fs from "node:fs";
import * as path from "node:path";

import { getDefaultConfig } from "../../../daemon/daemon.js";
import { exportSetupConfig } from "./declarative.js";

export interface SetupExportOptions {
  outputPath?: string;
}

function toConfigFileV2(config: Awaited<ReturnType<typeof exportSetupConfig>>): Record<string, unknown> {
  return {
    version: 2,
    "boss-name": config.bossName,
    "boss-timezone": config.bossTimezone,
    telegram: {
      "adapter-boss-id": config.telegramBossId,
    },
    memory: {
      enabled: config.memory.enabled,
      mode: config.memory.mode,
      "model-path": config.memory.modelPath,
      "model-uri": config.memory.modelUri,
      dims: config.memory.dims,
      "last-error": config.memory.lastError,
    },
    agents: config.agents.map((agent) => ({
      name: agent.name,
      role: agent.role,
      provider: agent.provider,
      description: agent.description,
      workspace: agent.workspace,
      model: agent.model,
      "reasoning-effort": agent.reasoningEffort,
      "permission-level": agent.permissionLevel,
      ...(agent.sessionPolicy
        ? {
            "session-policy": {
              ...(agent.sessionPolicy.dailyResetAt !== undefined
                ? { "daily-reset-at": agent.sessionPolicy.dailyResetAt }
                : {}),
              ...(agent.sessionPolicy.idleTimeout !== undefined
                ? { "idle-timeout": agent.sessionPolicy.idleTimeout }
                : {}),
              ...(agent.sessionPolicy.maxContextLength !== undefined
                ? { "max-context-length": agent.sessionPolicy.maxContextLength }
                : {}),
            },
          }
        : {}),
      ...(agent.metadata ? { metadata: agent.metadata } : {}),
      bindings: agent.bindings.map((binding) => ({
        "adapter-type": binding.adapterType,
        "adapter-token": binding.adapterToken,
      })),
    })),
  };
}

export async function runSetupExport(options: SetupExportOptions = {}): Promise<void> {
  const defaultPath = path.join(getDefaultConfig().dataDir, "config.json");
  const outputPath = path.resolve(process.cwd(), options.outputPath?.trim() || defaultPath);

  try {
    const config = await exportSetupConfig();
    const out = JSON.stringify(toConfigFileV2(config), null, 2) + "\n";

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, out, "utf8");

    console.log("✅ Setup config exported.\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`   config-path: ${outputPath}`);
    console.log(`   config-version: ${config.version}`);
    console.log(`   agent-count: ${config.agents.length}`);
    console.log(
      `   binding-count: ${config.agents.reduce((sum, agent) => sum + agent.bindings.length, 0)}`
    );
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("\nNote: boss token and agent tokens are never written to config files.\n");
  } catch (err) {
    console.error(`\n❌ Setup export failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
