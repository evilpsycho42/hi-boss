/**
 * RPC handler context and shared types.
 *
 * Provides the DaemonContext interface that exposes daemon internals
 * to RPC handlers, plus shared helpers for token validation and error handling.
 */

import type { HiBossDatabase } from "../db/database.js";
import type { MessageRouter } from "../router/message-router.js";
import type { AgentExecutor } from "../../agent/executor.js";
import type { EnvelopeScheduler } from "../scheduler/envelope-scheduler.js";
import type { CronScheduler } from "../scheduler/cron-scheduler.js";
import type { MemoryService } from "../memory/index.js";
import type { ChatAdapter } from "../../adapters/types.js";
import type { Agent } from "../../agent/types.js";
import type { RpcMethodHandler, RpcMethodRegistry } from "../ipc/types.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { PermissionLevel, PermissionPolicyV1 } from "../../shared/permissions.js";

/**
 * Principal type representing the authenticated caller.
 */
export type Principal =
  | { kind: "boss"; level: "boss" }
  | { kind: "agent"; level: PermissionLevel; agent: Agent };

/**
 * Context interface exposing daemon internals to RPC handlers.
 */
export interface DaemonContext {
  // Core services
  readonly db: HiBossDatabase;
  readonly router: MessageRouter;
  readonly executor: AgentExecutor;
  readonly scheduler: EnvelopeScheduler;
  readonly cronScheduler: CronScheduler | null;
  readonly adapters: Map<string, ChatAdapter>;

  // Configuration
  readonly config: { dataDir: string; debug?: boolean };
  readonly running: boolean;
  readonly startTime: Date | null;

  // Methods
  resolvePrincipal(token: string): Principal;
  assertOperationAllowed(operation: string, principal: { level: PermissionLevel }): void;
  getPermissionPolicy(): PermissionPolicyV1;

  // Memory service
  ensureMemoryService(): Promise<MemoryService>;
  getMemoryDisabledMessage(): string;
  writeMemoryConfigToDb(memory: {
    enabled: boolean;
    mode: "default" | "local";
    modelPath: string;
    modelUri: string;
    dims: number;
    lastError: string;
  }): void;
  closeMemoryService(): Promise<void>;

  // Adapter management
  createAdapterForBinding(adapterType: string, adapterToken: string): Promise<ChatAdapter | null>;
  removeAdapter(adapterToken: string): Promise<void>;

  // Agent handlers
  registerAgentHandler(agentName: string): void;
}

/**
 * Factory function type for creating RPC handlers.
 */
export type RpcHandlerFactory = (ctx: DaemonContext) => RpcMethodRegistry;

/**
 * RPC error helper.
 */
export function rpcError(code: number, message: string, data?: unknown): never {
  const err = new Error(message) as Error & { code: number; data?: unknown };
  err.code = code;
  err.data = data;
  throw err;
}

/**
 * Validate and extract token from params.
 */
export function requireToken(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "Token is required");
  }
  return value.trim();
}
