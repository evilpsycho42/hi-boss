/**
 * Setup configuration collected from user / config file.
 */
export interface SetupConfig {
  provider: "claude" | "codex";
  bossName: string;
  bossTimezone: string; // IANA timezone (used for all displayed timestamps)
  agent: {
    name: string;
    description?: string;
    workspace: string;
    model: string | null;
    reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | null;
    permissionLevel?: "restricted" | "standard" | "privileged" | "boss";
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
}
