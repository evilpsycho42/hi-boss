import type { SessionPolicyConfig } from "../shared/session-policy.js";
import type { PermissionLevel } from "../shared/permissions.js";

/**
 * Agent permission level (excluding 'boss' which is only for the boss token).
 */
export type AgentPermissionLevel = Exclude<PermissionLevel, "boss">;

/**
 * Agent definition for the Hi-Boss system.
 */
export interface Agent {
  name: string;            // unique identifier (alphanumeric, hyphens)
  token: string;           // agent token (short identifier, e.g. "abc123")
  description?: string;    // displayed to other agents
  workspace?: string;      // for unified-agent-sdk
  provider?: 'claude' | 'codex';
  model?: string;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  autoLevel?: 'low' | 'medium' | 'high';
  permissionLevel?: AgentPermissionLevel;   // authorization level for CLI/RPC ops
  sessionPolicy?: SessionPolicyConfig;      // session refresh policy
  createdAt: string;       // ISO 8601
  lastSeenAt?: string;     // ISO 8601
  metadata?: Record<string, unknown>;       // extensible metadata (for future use)
}

/**
 * Input for registering a new agent.
 */
export interface RegisterAgentInput {
  name: string;
  description?: string;
  workspace?: string;
  provider?: 'claude' | 'codex';
  model?: string;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  autoLevel?: 'low' | 'medium' | 'high';
  permissionLevel?: AgentPermissionLevel;
  sessionPolicy?: SessionPolicyConfig;
  metadata?: Record<string, unknown>;
}

/**
 * Result of agent registration, includes the token (only shown once).
 */
export interface RegisterAgentResult {
  agent: Agent;
  token: string;  // token, only returned on registration
}
