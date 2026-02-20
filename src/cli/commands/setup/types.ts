import type { AgentRole } from "../../../shared/agent-role.js";

export type SetupProvider = "claude" | "codex";
export type SetupReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type SetupPermissionLevel = "restricted" | "standard" | "privileged" | "boss";

export interface SetupSessionPolicy {
  dailyResetAt?: string;
  idleTimeout?: string;
  maxContextLength?: number;
}

export interface SetupAgentConfig {
  name: string;
  role: AgentRole;
  provider: SetupProvider;
  description?: string;
  workspace: string;
  model: string | null;
  reasoningEffort: SetupReasoningEffort | null;
  permissionLevel?: SetupPermissionLevel;
  sessionPolicy?: SetupSessionPolicy;
  metadata?: Record<string, unknown>;
}

export interface SetupBindingConfig {
  adapterType: string;
  adapterToken: string;
}

/**
 * Setup configuration collected from interactive wizard.
 */
export interface SetupConfig {
  bossName: string;
  bossTimezone: string; // IANA timezone (used for all displayed timestamps)
  speakerAgent: Omit<SetupAgentConfig, "role">;
  leaderAgent: Omit<SetupAgentConfig, "role">;
  adapter: {
    adapterType: string;
    adapterToken: string;
    adapterBossIds: string[];
  };
  bossToken: string;
}
