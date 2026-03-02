/**
 * JSON-RPC 2.0 types for Hi-Boss IPC.
 */

import type { Envelope } from "../../envelope/types.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom error codes
  UNAUTHORIZED: -32001,
  NOT_FOUND: -32002,
  ALREADY_EXISTS: -32003,
  DELIVERY_FAILED: -32010,
} as const;

/**
 * RPC method handler type.
 */
export type RpcMethodHandler = (
  params: Record<string, unknown>
) => Promise<unknown>;

/**
 * RPC method registry.
 */
export type RpcMethodRegistry = Record<string, RpcMethodHandler>;

// ==================== Method Parameters ====================

export interface EnvelopeSendParams {
  token: string;
  from?: string;
  to: string;
  fromBoss?: boolean;
  fromName?: string;
  text?: string;
  attachments?: Array<{ source: string; filename?: string; telegramFileId?: string }>;
  deliverAt?: string;
  interruptNow?: boolean;
  parseMode?: "plain" | "markdownv2" | "html";
  replyToEnvelopeId?: string;
  origin?: "cli" | "internal";
}

export interface EnvelopeSendResult {
  id?: string;
  ids?: string[];
  noRecipients?: boolean;
  interruptedWork?: boolean;
  priorityApplied?: boolean;
}

export interface EnvelopeListParams {
  token: string;
  to?: string;
  from?: string;
  status: "pending" | "done";
  limit?: number;
  createdAfter?: string;
  createdBefore?: string;
}

export interface EnvelopeThreadParams {
  token: string;
  envelopeId: string;
}

export interface EnvelopeThreadResult {
  maxDepth: number;
  totalCount: number;
  returnedCount: number;
  truncated: boolean;
  truncatedIntermediateCount: number;
  envelopes: Envelope[];
}

export interface SessionListParams {
  token: string;
  agentName?: string;
  limit?: number;
}

export interface SessionListResult {
  sessions: Array<{
    id: string;
    agentName: string;
    provider: "claude" | "codex";
    providerSessionId?: string;
    createdAt: number;
    lastActiveAt: number;
    lastAdapterType?: string;
    lastChatId?: string;
  }>;
}

export interface CronCreateParams {
  token: string;
  cron: string;
  timezone?: string; // IANA timezone (optional; missing means inherit boss timezone)
  to: string;
  text?: string;
  attachments?: Array<{ source: string; filename?: string; telegramFileId?: string }>;
  parseMode?: "plain" | "markdownv2" | "html";
  executionMode?: "isolated" | "clone" | "inline";
}

export interface CronListParams {
  token: string;
}

export interface CronEnableParams {
  token: string;
  id: string;
}

export interface CronDisableParams {
  token: string;
  id: string;
}

export interface CronDeleteParams {
  token: string;
  id: string;
}

// Backwards-compatible aliases (deprecated)
// (Removed) message.send / message.list aliases were dropped; use envelope.send / envelope.list.

export interface AgentRegisterParams {
  token: string;
  name: string;
  description?: string;
  workspace?: string;
  provider: "claude" | "codex";
  model?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | null;
  permissionLevel?: "restricted" | "standard" | "privileged" | "admin";
  metadata?: Record<string, unknown>;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxContextLength?: number;
  bindAdapterType?: string;
  bindAdapterToken?: string;
  dryRun?: boolean;
}

export interface AgentDeleteParams {
  token: string;
  agentName: string;
}

export interface AgentDeleteResult {
  success: boolean;
  agentName: string;
}

export interface ReactionSetParams {
  token: string;
  envelopeId: string; // short id, prefix, or full UUID (must reference a channel envelope)
  emoji: string;      // unicode emoji
}

export interface AgentBindParams {
  token: string;
  agentName: string;
  adapterType: string;
  adapterToken: string;
}

export interface AgentUnbindParams {
  token: string;
  agentName: string;
  adapterType: string;
}

export interface AgentRefreshParams {
  token: string;
  agentName: string;
}

export interface AgentSelfParams {
  token: string;
}

export interface AgentSelfResult {
  agent: {
    name: string;
    provider: 'claude' | 'codex';
    workspace: string;
    model?: string;
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  };
}

export interface AgentStatusParams {
  token: string;
  agentName: string;
}

export interface AgentAbortParams {
  token: string;
  agentName: string;
}

export interface AgentAbortResult {
  success: boolean;
  agentName: string;
  cancelledRun: boolean;
  clearedPendingCount: number;
}

export interface AgentStatusResult {
  agent: {
    name: string;
    description?: string;
    workspace?: string;
    provider?: "claude" | "codex";
    model?: string;
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
    permissionLevel?: "restricted" | "standard" | "privileged" | "admin";
    sessionPolicy?: {
      dailyResetAt?: string;
      idleTimeout?: string;
      maxContextLength?: number;
    };
  };
  bindings: string[];
  effective: {
    workspace: string;
    provider: "claude" | "codex";
    permissionLevel: "restricted" | "standard" | "privileged" | "admin";
  };
  status: {
    agentState: "running" | "idle";
    agentHealth: "ok" | "error" | "unknown";
    pendingCount: number;
    currentRun?: {
      id: string;
      startedAt: number;
    };
    lastRun?: {
      id: string;
      startedAt: number;
      completedAt?: number;
      status: "completed" | "failed" | "cancelled";
      error?: string;
      contextLength?: number;
    };
  };
}

export interface AgentSessionPolicySetParams {
  token: string;
  agentName: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxContextLength?: number;
  clear?: boolean;
}

export interface AgentSetParams {
  token: string;
  agentName: string;
  description?: string | null;
  workspace?: string | null;
  provider?: "claude" | "codex" | null;
  model?: string | null;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | null;
  permissionLevel?: "restricted" | "standard" | "privileged" | "admin";
  sessionPolicy?: {
    dailyResetAt?: string;
    idleTimeout?: string;
    maxContextLength?: number;
  } | null;
  metadata?: Record<string, unknown> | null;
  bindAdapterType?: string;
  bindAdapterToken?: string;
  unbindAdapterType?: string;
}

export interface AgentSetResult {
  success: boolean;
  agent: {
    name: string;
    description?: string;
    workspace?: string;
    provider: "claude" | "codex";
    model?: string;
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
    permissionLevel: "restricted" | "standard" | "privileged" | "admin";
    sessionPolicy?: unknown;
    metadata?: unknown;
  };
  bindings: string[];
}

export interface TeamRegisterParams {
  token: string;
  name: string;
  description?: string;
}

export interface TeamSetParams {
  token: string;
  teamName: string;
  description?: string | null;
  status?: "active" | "archived";
}

export interface TeamDeleteParams {
  token: string;
  teamName: string;
}

export interface TeamMemberAddParams {
  token: string;
  teamName: string;
  agentName: string;
}

export interface TeamMemberRemoveParams {
  token: string;
  teamName: string;
  agentName: string;
}

export interface TeamStatusParams {
  token: string;
  teamName: string;
}

export interface TeamListParams {
  token: string;
  status?: "active" | "archived";
}

export interface TeamListMembersParams {
  token: string;
  teamName: string;
}

export interface TeamSendParams {
  token: string;
  teamName: string;
  text?: string;
  attachments?: Array<{ source: string; filename?: string; telegramFileId?: string }>;
  deliverAt?: string;
  interruptNow?: boolean;
  replyToEnvelopeId?: string;
  origin?: "cli" | "internal";
}

export interface TeamRecordResult {
  name: string;
  description?: string;
  status: "active" | "archived";
  kind: "manual";
  createdAt: number;
  members: string[];
}

export interface TeamRegisterResult {
  success: boolean;
  team: TeamRecordResult;
}

export interface TeamSetResult {
  success: boolean;
  team: TeamRecordResult;
}

export interface TeamDeleteResult {
  success: boolean;
  teamName: string;
}

export interface TeamMemberAddResult {
  success: boolean;
  teamName: string;
  agentName: string;
}

export interface TeamMemberRemoveResult {
  success: boolean;
  teamName: string;
  agentName: string;
}

export interface TeamStatusResult {
  team: TeamRecordResult;
}

export interface TeamListResult {
  teams: TeamRecordResult[];
}

export interface TeamListMembersResult {
  teamName: string;
  members: Array<{
    agentName: string;
    source: "manual";
    createdAt: number;
  }>;
}

export interface TeamSendResult {
  teamName: string;
  requestedCount: number;
  sentCount: number;
  failedCount: number;
  results: Array<{
    agentName: string;
    success: boolean;
    envelopeId?: string;
    error?: string;
    interruptedWork?: boolean;
  }>;
}

export interface DaemonStatusParams {
  token: string;
}

export interface DaemonPingParams {
  token: string;
}

export interface DaemonTimeParams {
  token: string;
}

export interface DaemonTimeResult {
  bossTimezone: string;
  daemonTimezone: string;
}

// ==================== Setup Parameters ====================

export interface SetupCheckParams {
  // No params needed
}

export interface SetupCheckResult {
  completed: boolean;
  ready: boolean;
  agents: Array<{
    name: string;
    workspace?: string;
    provider?: "claude" | "codex";
  }>;
  userInfo: {
    bossName?: string;
    bossTimezone?: string;
    hasAdminToken: boolean;
    missing: {
      bossName: boolean;
      bossTimezone: boolean;
      adminToken: boolean;
    };
  };
}

export interface SetupExecuteParams {
  bossName: string;
  bossTimezone: string;
  primaryAgent: {
    name: string;
    provider: "claude" | "codex";
    description?: string;
    workspace?: string;
    model?: string | null;
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | null;
    permissionLevel?: 'restricted' | 'standard' | 'privileged' | 'admin';
    sessionPolicy?: {
      dailyResetAt?: string;
      idleTimeout?: string;
      maxContextLength?: number;
    };
    metadata?: Record<string, unknown>;
  };
  secondaryAgent?: {
    name: string;
    provider: "claude" | "codex";
    description?: string;
    workspace?: string;
    model?: string | null;
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | null;
    permissionLevel?: 'restricted' | 'standard' | 'privileged' | 'admin';
    sessionPolicy?: {
      dailyResetAt?: string;
      idleTimeout?: string;
      maxContextLength?: number;
    };
    metadata?: Record<string, unknown>;
  };
  adminToken: string;
  adapter: {
    adapterType: string;
    adapterToken: string;
    adapterBossIds: string[];
  };
}

export interface SetupExecuteResult {
  primaryAgentToken: string;
  secondaryAgentToken?: string;
}

export interface AdminVerifyParams {
  token: string;
}

export interface AdminVerifyResult {
  valid: boolean;
}
