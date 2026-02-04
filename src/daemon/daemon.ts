/**
 * Hi-Boss daemon - manages agents, messages, and platform integrations.
 */

import * as path from "path";
import { HiBossDatabase } from "./db/database.js";
import { IpcServer } from "./ipc/server.js";
import { MessageRouter } from "./router/message-router.js";
import { ChannelBridge } from "./bridges/channel-bridge.js";
import { AgentExecutor, createAgentExecutor } from "../agent/executor.js";
import type { Agent } from "../agent/types.js";
import { EnvelopeScheduler } from "./scheduler/envelope-scheduler.js";
import { CronScheduler } from "./scheduler/cron-scheduler.js";
import { MemoryService, MemoryStore } from "./memory/index.js";
import type { RpcMethodRegistry } from "./ipc/types.js";
import { RPC_ERRORS } from "./ipc/types.js";
import type { ChatAdapter } from "../adapters/types.js";
import { TelegramAdapter } from "../adapters/telegram.adapter.js";
import { DEFAULT_AGENT_PERMISSION_LEVEL, getDefaultHiBossDir } from "../shared/defaults.js";
import {
  DEFAULT_PERMISSION_POLICY,
  type PermissionLevel,
  type PermissionPolicyV1,
  getRequiredPermissionLevel,
  isAtLeastPermissionLevel,
  parsePermissionPolicyV1OrDefault,
} from "../shared/permissions.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import { getEnvelopeSourceFromEnvelope } from "../envelope/source.js";
import { PidLock, isDaemonRunning, isSocketAcceptingConnections } from "./pid-lock.js";
import type { DaemonContext, Principal } from "./rpc/context.js";
import { rpcError } from "./rpc/context.js";
import {
  createDaemonHandlers,
  createReactionHandlers,
  createCronHandlers,
  createMemoryHandlers,
  createEnvelopeHandlers,
  createSetupHandlers,
  createAgentHandlers,
  createAgentSetHandler,
  createAgentDeleteHandler,
} from "./rpc/index.js";
import { createChannelCommandHandler } from "./channel-commands.js";

// Re-export for CLI and external use
export { isDaemonRunning, isSocketAcceptingConnections };

/**
 * Hi-Boss daemon configuration.
 */
export interface DaemonConfig {
  dataDir: string;
  boss?: {
    telegram?: string;
  };
}

/**
 * Default configuration paths.
 */
export function getDefaultConfig(): DaemonConfig {
  return {
    dataDir: getDefaultHiBossDir(),
  };
}

/**
 * Get socket path for IPC client.
 */
export function getSocketPath(config: DaemonConfig = getDefaultConfig()): string {
  return path.join(config.dataDir, "daemon.sock");
}

/**
 * Hi-Boss daemon - manages agents, messages, and platform integrations.
 */
export class Daemon {
  private db: HiBossDatabase;
  private ipc: IpcServer;
  private router: MessageRouter;
  private bridge: ChannelBridge;
  private executor: AgentExecutor;
  private scheduler: EnvelopeScheduler;
  private cronScheduler: CronScheduler | null = null;
  private memoryService: MemoryService | null = null;
  private memoryStore: MemoryStore | null = null;
  private adapters: Map<string, ChatAdapter> = new Map(); // token -> adapter
  private running = false;
  private startTimeMs: number | null = null;
  private pidLock: PidLock;
  private defaultPermissionPolicy: PermissionPolicyV1 = DEFAULT_PERMISSION_POLICY;

  constructor(private config: DaemonConfig = getDefaultConfig()) {
    const dbPath = path.join(config.dataDir, "hiboss.db");
    const socketPath = path.join(config.dataDir, "daemon.sock");

    this.pidLock = new PidLock({ dataDir: config.dataDir });

    this.db = new HiBossDatabase(dbPath);
    this.ipc = new IpcServer(socketPath);
    this.router = new MessageRouter(this.db, {
      onEnvelopeDone: (envelope) => this.cronScheduler?.onEnvelopeDone(envelope),
    });
    this.bridge = new ChannelBridge(this.router, this.db, config);
    this.executor = createAgentExecutor({
      db: this.db,
      hibossDir: config.dataDir,
      onEnvelopesDone: (envelopeIds) => this.cronScheduler?.onEnvelopesDone(envelopeIds),
    });
    this.scheduler = new EnvelopeScheduler(this.db, this.router, this.executor);
    this.cronScheduler = new CronScheduler(this.db, this.scheduler);

    this.registerRpcMethods();
  }

  private getPermissionPolicy(): PermissionPolicyV1 {
    const raw = this.db.getConfig("permission_policy");
    return parsePermissionPolicyV1OrDefault(raw, this.defaultPermissionPolicy);
  }

  private getAgentPermissionLevel(agent: Agent): PermissionLevel {
    return agent.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL;
  }

  private resolvePrincipal(token: string): Principal {
    if (this.db.verifyBossToken(token)) {
      return { kind: "boss", level: "boss" };
    }

    const agent = this.db.findAgentByToken(token);
    if (!agent) {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Invalid token");
    }

    return { kind: "agent", level: this.getAgentPermissionLevel(agent), agent };
  }

  private assertOperationAllowed(operation: string, principal: { level: PermissionLevel }): void {
    const policy = this.getPermissionPolicy();
    const required = getRequiredPermissionLevel(policy, operation);
    if (!isAtLeastPermissionLevel(principal.level, required)) {
      rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
    }
  }

  private getMemoryDisabledMessage(): string {
    const lastError = (this.db.getConfig("memory_model_last_error") ?? "").trim();
    const suffix = lastError ? `: ${lastError}` : "";
    return `Memory is disabled${suffix}. Ask boss for help. Fix with: hiboss memory setup --default OR hiboss memory setup --model-path <path>`;
  }

  private writeMemoryConfigToDb(memory: {
    enabled: boolean;
    mode: "default" | "local";
    modelPath: string;
    modelUri: string;
    dims: number;
    lastError: string;
  }): void {
    this.db.setConfig("memory_enabled", memory.enabled ? "true" : "false");
    this.db.setConfig("memory_model_source", memory.mode);
    this.db.setConfig("memory_model_uri", memory.modelUri ?? "");
    this.db.setConfig("memory_model_path", memory.modelPath ?? "");
    this.db.setConfig("memory_model_dims", String(memory.dims ?? 0));
    this.db.setConfig("memory_model_last_error", memory.lastError ?? "");
  }

  private disableMemoryWithError(message: string): void {
    this.db.setConfig("memory_enabled", "false");
    this.db.setConfig("memory_model_last_error", message);
    this.db.setConfig("memory_model_dims", "0");
  }

  private async ensureMemoryService(): Promise<MemoryService> {
    if (this.memoryService) return this.memoryService;
    const enabled = this.db.getConfig("memory_enabled") === "true";
    if (!enabled) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, this.getMemoryDisabledMessage());
    }
    const modelPath = (this.db.getConfig("memory_model_path") ?? "").trim();
    if (!modelPath) {
      this.disableMemoryWithError("Missing memory model path");
      rpcError(RPC_ERRORS.INTERNAL_ERROR, this.getMemoryDisabledMessage());
    }

    try {
      this.memoryService = await MemoryService.create({ dataDir: this.config.dataDir, modelPath });
      return this.memoryService;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.disableMemoryWithError(message);
      rpcError(RPC_ERRORS.INTERNAL_ERROR, this.getMemoryDisabledMessage());
    }
  }

  private async ensureMemoryStore(): Promise<MemoryStore> {
    const enabled = this.db.getConfig("memory_enabled") === "true";
    if (!enabled) {
      rpcError(RPC_ERRORS.INTERNAL_ERROR, this.getMemoryDisabledMessage());
    }
    if (this.memoryStore) return this.memoryStore;
    const modelPath = (this.db.getConfig("memory_model_path") ?? "").trim();
    if (!modelPath) {
      this.disableMemoryWithError("Missing memory model path");
      rpcError(RPC_ERRORS.INTERNAL_ERROR, this.getMemoryDisabledMessage());
    }

    try {
      this.memoryStore = await MemoryStore.create({ dataDir: this.config.dataDir });
      return this.memoryStore;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.disableMemoryWithError(message);
      rpcError(RPC_ERRORS.INTERNAL_ERROR, this.getMemoryDisabledMessage());
    }
  }

  /**
   * Create the DaemonContext for RPC handlers.
   */
  private createContext(): DaemonContext {
    // Important: `running`/`startTimeMs` must reflect live daemon state (daemon.status depends on it).
    const daemon = this;
    return {
      db: this.db,
      router: this.router,
      executor: this.executor,
      scheduler: this.scheduler,
      cronScheduler: this.cronScheduler,
      adapters: this.adapters,
      config: this.config,
      get running() {
        return daemon.running;
      },
      get startTimeMs() {
        return daemon.startTimeMs;
      },
      resolvePrincipal: (token) => this.resolvePrincipal(token),
      assertOperationAllowed: (op, principal) => this.assertOperationAllowed(op, principal),
      getPermissionPolicy: () => this.getPermissionPolicy(),
      ensureMemoryService: () => this.ensureMemoryService(),
      ensureMemoryStore: () => this.ensureMemoryStore(),
      getMemoryDisabledMessage: () => this.getMemoryDisabledMessage(),
      writeMemoryConfigToDb: (m) => this.writeMemoryConfigToDb(m),
      closeMemoryService: async () => { await this.memoryService?.close().catch(() => undefined); this.memoryService = null; },
      closeMemoryStore: async () => { await this.memoryStore?.close().catch(() => undefined); this.memoryStore = null; },
      createAdapterForBinding: (type, token) => this.createAdapterForBinding(type, token),
      removeAdapter: (token) => this.removeAdapter(token),
      registerAgentHandler: (name) => this.registerSingleAgentHandler(name),
    };
  }

  /**
   * Start the daemon.
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Daemon is already running");
    }

    // Acquire flock-based PID lock (single-instance enforcement).
    await this.pidLock.acquire();

    try {
      // Start IPC server
      await this.ipc.start();

      // Mark as running early so stop() can clean up partial startups.
      this.running = true;
      this.startTimeMs = Date.now();

      const daemonMode = (process.env.HIBOSS_DAEMON_MODE ?? "").trim().toLowerCase();
      const examplesMode = daemonMode === "examples";
      if (examplesMode) {
        // IPC-only daemon for generating deterministic docs (no schedulers/adapters/auto-execution).
        logEvent("info", "daemon-started", { "data-dir": this.config.dataDir, "adapters-count": 0, mode: "examples" });
        return;
      }

      // Set up command handler for /new etc.
      this.setupCommandHandler();

      // Load bindings and create adapters
      await this.loadBindings();

      // Register agent handlers for auto-execution
      await this.registerAgentExecutionHandlers();

      // Start all loaded adapters
      for (const adapter of this.adapters.values()) {
        await adapter.start();
      }

      // Cron: skip missed runs before any startup delivery/turn triggers.
      this.cronScheduler?.reconcileAllSchedules({ skipMisfires: true });

      // Start scheduler after adapters/handlers are ready
      this.scheduler.start();

      // Process any pending envelopes from before restart
      await this.processPendingEnvelopes();
    } catch (err) {
      // Best-effort cleanup to avoid leaving stale pid/socket files.
      await this.stop().catch(() => {});
      await this.pidLock.release();
      this.running = false;
      throw err;
    }

    logEvent("info", "daemon-started", {
      "data-dir": this.config.dataDir,
      "adapters-count": this.adapters.size,
    });
  }

  /**
   * Set up command handler for adapter commands.
   */
  private setupCommandHandler(): void {
    this.bridge.setCommandHandler(createChannelCommandHandler({ db: this.db, executor: this.executor }));
  }

  /**
   * Register handlers for all agents to trigger execution on new envelopes.
   */
  private async registerAgentExecutionHandlers(): Promise<void> {
    const agents = this.db.listAgents();

    for (const agent of agents) {
      this.registerSingleAgentHandler(agent.name);
    }
  }

  /**
   * Register a single agent handler for auto-execution.
   */
  private registerSingleAgentHandler(agentName: string): void {
    this.router.registerAgentHandler(agentName, async (envelope) => {
      const currentAgent = this.db.getAgentByName(agentName);
      if (!currentAgent) {
        logEvent("error", "agent-not-found", { "agent-name": agentName });
        return;
      }

      // Non-blocking: trigger agent run
      this.executor.checkAndRun(currentAgent, this.db, {
        kind: "envelope",
        source: getEnvelopeSourceFromEnvelope(envelope),
        envelopeId: envelope.id,
      }).catch((err) => {
        logEvent("error", "agent-check-and-run-failed", {
          "agent-name": agentName,
          error: errorMessage(err),
        });
      });
    });
  }

  /**
   * Process any pending envelopes that existed before daemon restart.
   */
  private async processPendingEnvelopes(): Promise<void> {
    const agents = this.db.listAgents();

    for (const agent of agents) {
      const pending = this.db.getPendingEnvelopesForAgent(agent.name, 1);
      if (pending.length > 0) {
        this.executor.checkAndRun(agent, this.db, { kind: "daemon-startup" }).catch((err) => {
          logEvent("error", "agent-check-and-run-failed", {
            "agent-name": agent.name,
            error: errorMessage(err),
          });
        });
      }
    }
  }

  /**
   * Load bindings from database and create adapters.
   */
  private async loadBindings(): Promise<void> {
    const bindings = this.db.listBindings();

    for (const binding of bindings) {
      await this.createAdapterForBinding(binding.adapterType, binding.adapterToken);
    }
  }

  /**
   * Create an adapter for a binding.
   */
  private async createAdapterForBinding(
    adapterType: string,
    adapterToken: string
  ): Promise<ChatAdapter | null> {
    // Check if adapter already exists
    if (this.adapters.has(adapterToken)) {
      return this.adapters.get(adapterToken)!;
    }

    let adapter: ChatAdapter;

    switch (adapterType) {
      case "telegram":
        adapter = new TelegramAdapter(adapterToken);
        break;
      default:
        logEvent("error", "adapter-unknown-type", { "adapter-type": adapterType });
        return null;
    }

    this.adapters.set(adapterToken, adapter);
    this.bridge.connect(adapter, adapterToken);

    if (this.running) {
      await adapter.start();
    }

    return adapter;
  }

  /**
   * Remove an adapter.
   */
  private async removeAdapter(adapterToken: string): Promise<void> {
    const adapter = this.adapters.get(adapterToken);
    if (adapter) {
      await adapter.stop();
      this.adapters.delete(adapterToken);
    }
  }

  /**
   * Stop the daemon.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    // Stop scheduler first (prevents new work while shutting down)
    this.scheduler.stop();

    // Stop all adapters
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }

    // Close agent executor
    await this.executor.closeAll();

    // Stop IPC server
    await this.ipc.stop();

    // Close semantic memory service
    await this.memoryService?.close().catch(() => undefined);
    this.memoryService = null;

    // Close semantic memory store (non-embedding operations)
    await this.memoryStore?.close().catch(() => undefined);
    this.memoryStore = null;

    // Close database
    this.db.close();

    // Release flock-based PID lock
    await this.pidLock.release();

    this.running = false;
    logEvent("info", "daemon-stopped");
  }

  /**
   * Check if daemon is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Register all RPC methods using extracted handlers.
   */
  private registerRpcMethods(): void {
    const ctx = this.createContext();

    const methods: RpcMethodRegistry = {
      ...createEnvelopeHandlers(ctx),
      ...createReactionHandlers(ctx),
      ...createCronHandlers(ctx),
      ...createMemoryHandlers(ctx),
      ...createAgentHandlers(ctx),
      ...createAgentSetHandler(ctx),
      ...createAgentDeleteHandler(ctx),
      ...createDaemonHandlers(ctx),
      ...createSetupHandlers(ctx),
    };

    this.ipc.registerMethods(methods);
  }
}
