/**
 * JSON-RPC 2.0 types for Hi-Boss IPC.
 */

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
  attachments?: Array<{ source: string; filename?: string }>;
  deliverAt?: string;
}

export interface EnvelopeListParams {
  token: string;
  address?: string;
  box?: "inbox" | "outbox";
  status?: "pending" | "done";
  limit?: number;
}

export interface EnvelopeGetParams {
  token: string;
  id: string;
}

export interface TurnPreviewParams {
  token: string;
  agentName?: string;
  limit?: number;
}

// Backwards-compatible aliases (deprecated)
export type MessageSendParams = EnvelopeSendParams;
export type MessageListParams = EnvelopeListParams;
export type MessageGetParams = EnvelopeGetParams;

export interface AgentRegisterParams {
  token: string;
  name: string;
  description?: string;
  workspace?: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxTokens?: number;
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
    reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
    autoLevel: 'low' | 'medium' | 'high';
  };
}

export interface AgentSessionPolicySetParams {
  token: string;
  agentName: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxTokens?: number;
  clear?: boolean;
}

export interface DaemonStatusParams {
  token: string;
}

export interface DaemonPingParams {
  token: string;
}

// ==================== Setup Parameters ====================

export interface SetupCheckParams {
  // No params needed
}

export interface SetupCheckResult {
  completed: boolean;
}

export interface SetupExecuteParams {
  provider: 'claude' | 'codex';
  bossName: string;
  agent: {
    name: string;
    description?: string;
    workspace?: string;
    model?: string;
    reasoningEffort?: 'low' | 'medium' | 'high';
    autoLevel?: 'low' | 'medium' | 'high';
  };
  bossToken: string;
  adapter?: {
    adapterType: string;
    adapterToken: string;
    adapterBossId?: string;
  };
}

export interface SetupExecuteResult {
  agentToken: string;
}

export interface BossVerifyParams {
  token: string;
}

export interface BossVerifyResult {
  valid: boolean;
}
