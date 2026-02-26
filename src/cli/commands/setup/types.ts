import type { KnownAdapterType } from "../../../shared/adapter-types.js";

export type SetupProvider = "claude" | "codex";
export type SetupReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type SetupPermissionLevel = "restricted" | "standard" | "privileged" | "admin";

export interface SetupSessionPolicy {
  dailyResetAt?: string;
  idleTimeout?: string;
  maxContextLength?: number;
}

export interface SetupAgentConfig {
  name: string;
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
  adapterType: KnownAdapterType;
  adapterToken: string;
}

/**
 * Setup configuration collected from interactive wizard.
 */
export interface SetupConfig {
  bossName: string;
  bossTimezone: string; // IANA timezone (used for all displayed timestamps)
  primaryAgent: SetupAgentConfig;
  secondaryAgent: SetupAgentConfig;
  adapter: {
    adapterType: KnownAdapterType;
    adapterToken: string;
    adapterBossIds: string[];
  };
  adminToken: string;
}
