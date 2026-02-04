import type { MemoryModelMode, ResolvedMemoryModelConfig } from "../../memory-model.js";

/**
 * Setup configuration collected from user / config file.
 */
export interface SetupConfig {
  provider: "claude" | "codex";
  providerSourceHome?: string;
  bossName: string;
  bossTimezone: string; // IANA timezone (used for all displayed timestamps)
  agent: {
    name: string;
    description?: string;
    workspace: string;
    model: string | null;
    reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | null;
    autoLevel: "medium" | "high";
    permissionLevel?: "restricted" | "standard" | "privileged";
    sessionPolicy?: {
      dailyResetAt?: string;
      idleTimeout?: string;
      maxContextLength?: number;
    };
    metadata?: Record<string, unknown>;
  };
  adapter: {
    adapterType: string;
    adapterToken: string;
    adapterBossId: string;
  };
  bossToken: string;
  memory?: ResolvedMemoryModelConfig;
  memorySelection?: { mode: MemoryModelMode; modelPath?: string };
}
