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
import { MemoryService } from "./memory/index.js";
import type { RpcMethodRegistry } from "./ipc/types.js";
import { RPC_ERRORS } from "./ipc/types.js";
import type { ChatAdapter } from "../adapters/types.js";
import { formatAgentAddress } from "../adapters/types.js";
import { TelegramAdapter } from "../adapters/telegram.adapter.js";
import { nowLocalIso } from "../shared/time.js";
import { red } from "../shared/ansi.js";
import { DEFAULT_AGENT_PERMISSION_LEVEL, getDefaultHiBossDir } from "../shared/defaults.js";
import {
  DEFAULT_PERMISSION_POLICY,
  type PermissionLevel,
  type PermissionPolicyV1,
  getRequiredPermissionLevel,
  isAtLeastPermissionLevel,
  parsePermissionPolicyV1OrDefault,
} from "../shared/permissions.js";
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

// Re-export for CLI and external use
export { isDaemonRunning, isSocketAcceptingConnections };

/**
 * Hi-Boss daemon configuration.
 */
export interface DaemonConfig {
  dataDir: string;
  debug?: boolean;
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
  private adapters: Map<string, ChatAdapter> = new Map(); // token -> adapter
  private running = false;
  private startTime: Date | null = null;
  private pidLock: PidLock;
  private defaultPermissionPolicy: PermissionPolicyV1 = DEFAULT_PERMISSION_POLICY;

  constructor(private config: DaemonConfig = getDefaultConfig()) {
    const dbPath = path.join(config.dataDir, "hiboss.db");
    const socketPath = path.join(config.dataDir, "daemon.sock");

    this.pidLock = new PidLock({ dataDir: config.dataDir });

    this.db = new HiBossDatabase(dbPath);
    this.ipc = new IpcServer(socketPath);
    this.router = new MessageRouter(this.db, {
      debug: config.debug,
      onEnvelopeDone: (envelope) => this.cronScheduler?.onEnvelopeDone(envelope),
    });
    this.bridge = new ChannelBridge(this.router, this.db, config);
    this.executor = createAgentExecutor({
      debug: config.debug,
      db: this.db,
      hibossDir: config.dataDir,
      onEnvelopesDone: (envelopeIds) => this.cronScheduler?.onEnvelopesDone(envelopeIds),
    });
    this.scheduler = new EnvelopeScheduler(this.db, this.router, this.executor, {
      debug: config.debug,
    });
    this.cronScheduler = new CronScheduler(this.db, this.scheduler, { debug: config.debug });

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
      this.memoryService = await MemoryService.create({
        dataDir: this.config.dataDir,
        modelPath,
      });
      return this.memoryService;
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
    const daemon = this;
    return {
      db: daemon.db,
      router: daemon.router,
      executor: daemon.executor,
      scheduler: daemon.scheduler,
      cronScheduler: daemon.cronScheduler,
      adapters: daemon.adapters,
      config: daemon.config,
      get running() {
        return daemon.running;
      },
      get startTime() {
        return daemon.startTime;
      },

      resolvePrincipal: (token) => daemon.resolvePrincipal(token),
      assertOperationAllowed: (op, principal) => daemon.assertOperationAllowed(op, principal),
      getPermissionPolicy: () => daemon.getPermissionPolicy(),

      ensureMemoryService: () => daemon.ensureMemoryService(),
      getMemoryDisabledMessage: () => daemon.getMemoryDisabledMessage(),
      writeMemoryConfigToDb: (m) => daemon.writeMemoryConfigToDb(m),
      closeMemoryService: async () => {
        await daemon.memoryService?.close().catch(() => undefined);
        daemon.memoryService = null;
      },

      createAdapterForBinding: (type, token) => daemon.createAdapterForBinding(type, token),
      removeAdapter: (token) => daemon.removeAdapter(token),

      registerAgentHandler: (name) => daemon.registerSingleAgentHandler(name),
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
      this.startTime = new Date();

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

    console.log(`[${nowLocalIso()}] [Daemon] Started`);
    console.log(`[${nowLocalIso()}] [Daemon] Data directory: ${this.config.dataDir}`);
    console.log(`[${nowLocalIso()}] [Daemon] Loaded ${this.adapters.size} adapter(s)`);
  }

  /**
   * Set up command handler for adapter commands.
   */
  private setupCommandHandler(): void {
    this.bridge.setCommandHandler(async (command) => {
      const enrichedCommand = command as typeof command & { agentName?: string };

      if (command.command === "new" && enrichedCommand.agentName) {
        console.log(
          red(`[${nowLocalIso()}] [Daemon] Session refresh requested for ${formatAgentAddress(enrichedCommand.agentName)}`)
        );
        this.executor.requestSessionRefresh(enrichedCommand.agentName, "telegram:/new");
      }
    });
  }

  /**
   * Register handlers for all agents to trigger execution on new envelopes.
   */
  private async registerAgentExecutionHandlers(): Promise<void> {
    const agents = this.db.listAgents();
    console.log(`[${nowLocalIso()}] [Daemon] Registering handlers for ${agents.length} agent(s)`);

    for (const agent of agents) {
      this.registerSingleAgentHandler(agent.name);
    }
  }

  /**
   * Register a single agent handler for auto-execution.
   */
  private registerSingleAgentHandler(agentName: string): void {
    console.log(`[${nowLocalIso()}] [Daemon] Registering handler for ${formatAgentAddress(agentName)}`);
    this.router.registerAgentHandler(agentName, async () => {
      console.log(`[${nowLocalIso()}] [Daemon] Handler triggered for ${formatAgentAddress(agentName)}`);

      const currentAgent = this.db.getAgentByName(agentName);
      if (!currentAgent) {
        console.error(`[Daemon] Agent ${agentName} not found in database`);
        return;
      }

      // Non-blocking: trigger agent run
      this.executor.checkAndRun(currentAgent, this.db).catch((err) => {
        console.error(`[Daemon] Agent ${agentName} run failed:`, err);
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
        console.log(
          `[${nowLocalIso()}] [Daemon] Found ${pending.length}+ pending envelope(s) for ${formatAgentAddress(agent.name)}, triggering run`
        );
        this.executor.checkAndRun(agent, this.db).catch((err) => {
          console.error(`[Daemon] Agent ${agent.name} startup run failed:`, err);
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
        console.error(`[Daemon] Unknown adapter type: ${adapterType}`);
        return null;
    }

    this.adapters.set(adapterToken, adapter);
    this.bridge.connect(adapter, adapterToken);

    if (this.running) {
      await adapter.start();
    }

    console.log(`[${nowLocalIso()}] [Daemon] Created ${adapterType} adapter`);
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
      console.log(`[${nowLocalIso()}] [Daemon] Removed adapter`);
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

    // Close database
    this.db.close();

    // Release flock-based PID lock
    await this.pidLock.release();

    this.running = false;
    console.log(`[${nowLocalIso()}] [Daemon] Stopped`);
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
