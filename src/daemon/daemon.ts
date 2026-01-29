import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as net from "net";
import { HiBossDatabase } from "./db/database.js";
import { IpcServer } from "./ipc/server.js";
import { MessageRouter } from "./router/message-router.js";
import { ChannelBridge } from "./bridges/channel-bridge.js";
import { AgentExecutor, createAgentExecutor } from "../agent/executor.js";
import type { Agent } from "../agent/types.js";
import { setupAgentHome } from "../agent/home-setup.js";
import { EnvelopeScheduler } from "./scheduler/envelope-scheduler.js";
import type { RpcMethodRegistry } from "./ipc/types.js";
import {
  RPC_ERRORS,
  type EnvelopeSendParams,
  type EnvelopeListParams,
  type EnvelopeGetParams,
  type AgentRegisterParams,
  type AgentBindParams,
  type AgentUnbindParams,
  type AgentRefreshParams,
  type AgentSelfParams,
  type AgentSessionPolicySetParams,
  type SetupExecuteParams,
  type BossVerifyParams,
} from "./ipc/types.js";
import type { ChatAdapter } from "../adapters/types.js";
import { formatAgentAddress, parseAddress } from "../adapters/types.js";
import { TelegramAdapter } from "../adapters/telegram.adapter.js";
import { parseDateTimeInputToUtcIso, nowLocalIso } from "../shared/time.js";
import { parseDailyResetAt, parseDurationToMs } from "../shared/session-policy.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../shared/validation.js";
import {
  DEFAULT_PERMISSION_POLICY,
  type PermissionLevel,
  type PermissionPolicyV1,
  getRequiredPermissionLevel,
  isAtLeastPermissionLevel,
  parsePermissionPolicyV1OrDefault,
} from "../shared/permissions.js";

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
    dataDir: path.join(os.homedir(), ".hiboss"),
  };
}

/**
 * RPC error helper.
 */
function rpcError(code: number, message: string, data?: unknown): never {
  const err = new Error(message) as Error & { code: number; data?: unknown };
  err.code = code;
  err.data = data;
  throw err;
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
  private adapters: Map<string, ChatAdapter> = new Map(); // token -> adapter
  private running = false;
  private startTime: Date | null = null;
  private pidPath: string;
  private defaultPermissionPolicy: PermissionPolicyV1 = DEFAULT_PERMISSION_POLICY;

  constructor(private config: DaemonConfig = getDefaultConfig()) {
    const dbPath = path.join(config.dataDir, "hiboss.db");
    const socketPath = path.join(config.dataDir, "daemon.sock");
    this.pidPath = path.join(config.dataDir, "daemon.pid");

    this.db = new HiBossDatabase(dbPath);
    this.ipc = new IpcServer(socketPath);
    this.router = new MessageRouter(this.db, { debug: config.debug });
    this.bridge = new ChannelBridge(this.router, this.db, config);
    this.executor = createAgentExecutor({ debug: config.debug, db: this.db, hibossDir: config.dataDir });
    this.scheduler = new EnvelopeScheduler(this.db, this.router, this.executor, {
      debug: config.debug,
    });

    this.registerRpcMethods();
  }

  private getPermissionPolicy(): PermissionPolicyV1 {
    const raw = this.db.getConfig("permission_policy");
    return parsePermissionPolicyV1OrDefault(raw, this.defaultPermissionPolicy);
  }

  private getAgentPermissionLevel(agent: Agent): PermissionLevel {
    return agent.permissionLevel ?? "standard";
  }

  private resolvePrincipal(token: string):
    | { kind: "boss"; level: "boss" }
    | { kind: "agent"; level: PermissionLevel; agent: Agent } {
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

  /**
   * Start the daemon.
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Daemon is already running");
    }

    // Create PID file atomically (single-instance lock).
    await this.acquirePidFileLock();

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

      // Start scheduler after adapters/handlers are ready
      this.scheduler.start();

      // Process any pending envelopes from before restart
      await this.processPendingEnvelopes();
    } catch (err) {
      // Best-effort cleanup to avoid leaving stale pid/socket files.
      await this.stop().catch(() => {});
      this.releasePidFileLock();
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
        console.log(`[${nowLocalIso()}] [Daemon] Session refresh requested for agent: ${enrichedCommand.agentName}`);
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
      console.log(`[${nowLocalIso()}] [Daemon] Registering handler for agent: ${agent.name}`);
      const agentName = agent.name;
      this.router.registerAgentHandler(agentName, async () => {
        console.log(`[${nowLocalIso()}] [Daemon] Handler triggered for agent: ${agentName}`);

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
  }

  /**
   * Process any pending envelopes that existed before daemon restart.
   */
  private async processPendingEnvelopes(): Promise<void> {
    const agents = this.db.listAgents();

    for (const agent of agents) {
      const pending = this.db.getPendingEnvelopesForAgent(agent.name, 1);
      if (pending.length > 0) {
        console.log(`[${nowLocalIso()}] [Daemon] Found ${pending.length}+ pending envelope(s) for ${agent.name}, triggering run`);
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

    // Close database
    this.db.close();

    // Remove PID file
    this.releasePidFileLock();

    this.running = false;
    console.log(`[${nowLocalIso()}] [Daemon] Stopped`);
  }

  /**
   * Check if daemon is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  private registerRpcMethods(): void {
    const requireToken = (value: unknown): string => {
      if (typeof value !== "string" || !value.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Token is required");
      }
      return value.trim();
    };

    const createEnvelopeSend = (operation: string) => async (params: Record<string, unknown>) => {
      const p = params as unknown as EnvelopeSendParams;
      const token = requireToken(p.token);
      const principal = this.resolvePrincipal(token);
      this.assertOperationAllowed(operation, principal);

      if (typeof p.to !== "string" || !p.to.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid to");
      }

      let destination: ReturnType<typeof parseAddress>;
      try {
        destination = parseAddress(p.to);
      } catch (err) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, err instanceof Error ? err.message : "Invalid to");
      }

      let from: string;
      let fromBoss = false;
      let metadata: Record<string, unknown> | undefined;

      if (principal.kind === "boss") {
        if (typeof p.from !== "string" || !p.from.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Boss token requires from");
        }
        from = p.from.trim();
        fromBoss = p.fromBoss === true;

        if (typeof p.fromName === "string" && p.fromName.trim()) {
          metadata = { fromName: p.fromName.trim() };
        }
      } else {
        if (p.from !== undefined || p.fromBoss !== undefined || p.fromName !== undefined) {
          rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
        }

        const agent = principal.agent;
        this.db.updateAgentLastSeen(agent.name);
        from = formatAgentAddress(agent.name);

        // Check binding for channel destinations (agent sender only)
        if (destination.type === "channel") {
          const binding = this.db.getAgentBindingByType(agent.name, destination.adapter);
          if (!binding) {
            rpcError(
              RPC_ERRORS.UNAUTHORIZED,
              `Agent '${agent.name}' is not bound to adapter '${destination.adapter}'`
            );
          }
        }
      }

      // Validate channel delivery requirements: sending to a channel requires from=agent:*
      if (destination.type === "channel") {
        let sender: ReturnType<typeof parseAddress>;
        try {
          sender = parseAddress(from);
        } catch (err) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, err instanceof Error ? err.message : "Invalid from");
        }
        if (sender.type !== "agent") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Channel destinations require from=agent:<name>");
        }

        // Boss token can impersonate senders, but channel delivery still requires a real binding.
        if (principal.kind === "boss") {
          const binding = this.db.getAgentBindingByType(sender.agentName, destination.adapter);
          if (!binding) {
            rpcError(
              RPC_ERRORS.INVALID_PARAMS,
              `Sender agent '${sender.agentName}' is not bound to adapter '${destination.adapter}'`
            );
          }
        }
      }

      let deliverAt: string | undefined;
      if (p.deliverAt) {
        try {
          deliverAt = parseDateTimeInputToUtcIso(p.deliverAt);
        } catch (err) {
          rpcError(
            RPC_ERRORS.INVALID_PARAMS,
            err instanceof Error ? err.message : "Invalid deliver-at"
          );
        }
      }

      const envelope = await this.router.routeEnvelope({
        from,
        to: p.to,
        fromBoss,
        content: {
          text: p.text,
          attachments: p.attachments,
        },
        deliverAt,
        metadata,
      });

      this.scheduler.onEnvelopeCreated(envelope);
      return { id: envelope.id };
    };

    const createEnvelopeList = (operation: string) => async (params: Record<string, unknown>) => {
      const p = params as unknown as EnvelopeListParams;
      const token = requireToken(p.token);
      const principal = this.resolvePrincipal(token);
      this.assertOperationAllowed(operation, principal);

      let address: string;
      if (principal.kind === "boss") {
        if (typeof p.address !== "string" || !p.address.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Boss token requires address");
        }
        address = p.address.trim();
        try {
          parseAddress(address);
        } catch (err) {
          rpcError(
            RPC_ERRORS.INVALID_PARAMS,
            err instanceof Error ? err.message : "Invalid address"
          );
        }
      } else {
        if (p.address !== undefined) {
          rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
        }
        this.db.updateAgentLastSeen(principal.agent.name);
        address = formatAgentAddress(principal.agent.name);
      }

      const envelopes = this.db.listEnvelopes({
        address,
        box: p.box ?? "inbox",
        status: p.status,
        limit: p.limit,
      });

      return { envelopes };
    };

    const createEnvelopeGet = (operation: string) => async (params: Record<string, unknown>) => {
      const p = params as unknown as EnvelopeGetParams;
      const token = requireToken(p.token);
      const principal = this.resolvePrincipal(token);
      this.assertOperationAllowed(operation, principal);

      if (principal.kind === "agent") {
        this.db.updateAgentLastSeen(principal.agent.name);
      }

      const envelope = this.db.getEnvelopeById(p.id);
      if (!envelope) {
        rpcError(RPC_ERRORS.NOT_FOUND, "Envelope not found");
      }

      if (principal.kind === "agent") {
        // Verify the agent has access to this envelope
        const agentAddress = formatAgentAddress(principal.agent.name);
        if (envelope.to !== agentAddress && envelope.from !== agentAddress) {
          rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
        }
      }

      return { envelope };
    };

    const methods: RpcMethodRegistry = {
      // Envelope methods (canonical)
      "envelope.send": createEnvelopeSend("envelope.send"),
      "envelope.list": createEnvelopeList("envelope.list"),
      "envelope.get": createEnvelopeGet("envelope.get"),

      // Message methods (backwards-compatible aliases)
      "message.send": createEnvelopeSend("message.send"),
      "message.list": createEnvelopeList("message.list"),
      "message.get": createEnvelopeGet("message.get"),

      // Agent methods
      "agent.register": async (params) => {
        const p = params as unknown as AgentRegisterParams;
        const token = requireToken(p.token);
        const principal = this.resolvePrincipal(token);
        this.assertOperationAllowed("agent.register", principal);

        if (typeof p.name !== "string" || !isValidAgentName(p.name)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, AGENT_NAME_ERROR_MESSAGE);
        }

        // Check if agent already exists (case-insensitive)
        const existing = this.db.getAgentByNameCaseInsensitive(p.name);
        if (existing) {
          rpcError(RPC_ERRORS.ALREADY_EXISTS, "Agent already exists");
        }

        const sessionPolicy: Record<string, unknown> = {};
        if (p.sessionDailyResetAt !== undefined) {
          if (typeof p.sessionDailyResetAt !== "string") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-daily-reset-at");
          }
          sessionPolicy.dailyResetAt = parseDailyResetAt(p.sessionDailyResetAt).normalized;
        }
        if (p.sessionIdleTimeout !== undefined) {
          if (typeof p.sessionIdleTimeout !== "string") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-idle-timeout");
          }
          // Validate duration; store original (trimmed) for readability.
          parseDurationToMs(p.sessionIdleTimeout);
          sessionPolicy.idleTimeout = p.sessionIdleTimeout.trim();
        }
        if (p.sessionMaxTokens !== undefined) {
          if (typeof p.sessionMaxTokens !== "number" || !Number.isFinite(p.sessionMaxTokens)) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-max-tokens");
          }
          if (p.sessionMaxTokens <= 0) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-max-tokens (must be > 0)");
          }
          sessionPolicy.maxTokens = Math.trunc(p.sessionMaxTokens);
        }

        const result = this.db.registerAgent({
          name: p.name,
          description: p.description,
          workspace: p.workspace,
          sessionPolicy: Object.keys(sessionPolicy).length > 0 ? sessionPolicy as any : undefined,
        });

        // Setup agent home directories
        await setupAgentHome(p.name, this.config.dataDir);

        // Register agent handler for auto-execution
        this.router.registerAgentHandler(p.name, async () => {
          const currentAgent = this.db.getAgentByName(p.name);
          if (!currentAgent) {
            console.error(`[Daemon] Agent ${p.name} not found in database`);
            return;
          }

          this.executor.checkAndRun(currentAgent, this.db).catch((err) => {
            console.error(`[Daemon] Agent ${p.name} run failed:`, err);
          });
        });

        return {
          agent: {
            name: result.agent.name,
            description: result.agent.description,
            workspace: result.agent.workspace,
            createdAt: result.agent.createdAt,
          },
          token: result.token,
        };
      },

      "agent.list": async (params) => {
        const p = params as unknown as { token: string };
        const token = requireToken(p.token);
        const principal = this.resolvePrincipal(token);
        this.assertOperationAllowed("agent.list", principal);

        const agents = this.db.listAgents();
        const bindings = this.db.listBindings();

        // Group bindings by agent
        const bindingsByAgent = new Map<string, string[]>();
        for (const b of bindings) {
          const list = bindingsByAgent.get(b.agentName) ?? [];
          list.push(b.adapterType);
          bindingsByAgent.set(b.agentName, list);
        }

        return {
          agents: agents.map((a) => ({
            name: a.name,
            description: a.description,
            workspace: a.workspace,
            provider: a.provider,
            model: a.model,
            reasoningEffort: a.reasoningEffort,
            autoLevel: a.autoLevel,
            permissionLevel: a.permissionLevel,
            sessionPolicy: a.sessionPolicy,
            createdAt: a.createdAt,
            lastSeenAt: a.lastSeenAt,
            metadata: a.metadata,
            bindings: bindingsByAgent.get(a.name) ?? [],
          })),
        };
      },

      "agent.bind": async (params) => {
        const p = params as unknown as AgentBindParams;
        const token = requireToken(p.token);
        const principal = this.resolvePrincipal(token);
        this.assertOperationAllowed("agent.bind", principal);

        // Check if agent exists
        const agent = this.db.getAgentByNameCaseInsensitive(p.agentName);
        if (!agent) {
          rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
        }

        const agentName = agent.name;

        // Check if this adapter token is already bound to another agent
        const existingBinding = this.db.getBindingByAdapter(p.adapterType, p.adapterToken);
        if (existingBinding && existingBinding.agentName !== agentName) {
          rpcError(
            RPC_ERRORS.ALREADY_EXISTS,
            `This ${p.adapterType} bot is already bound to agent '${existingBinding.agentName}'`
          );
        }

        // Check if agent already has a binding for this adapter type
        const agentBinding = this.db.getAgentBindingByType(agentName, p.adapterType);
        if (agentBinding) {
          rpcError(
            RPC_ERRORS.ALREADY_EXISTS,
            `Agent '${agentName}' already has a ${p.adapterType} binding`
          );
        }

        // Create binding
        const binding = this.db.createBinding(agentName, p.adapterType, p.adapterToken);

        // Create adapter if daemon is running
        if (this.running) {
          await this.createAdapterForBinding(p.adapterType, p.adapterToken);
        }

        return {
          binding: {
            id: binding.id,
            agentName: binding.agentName,
            adapterType: binding.adapterType,
            createdAt: binding.createdAt,
          },
        };
      },

      "agent.unbind": async (params) => {
        const p = params as unknown as AgentUnbindParams;
        const token = requireToken(p.token);
        const principal = this.resolvePrincipal(token);
        this.assertOperationAllowed("agent.unbind", principal);

        const agent = this.db.getAgentByNameCaseInsensitive(p.agentName);
        if (!agent) {
          rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
        }
        const agentName = agent.name;

        // Get the binding to find the adapter token
        const binding = this.db.getAgentBindingByType(agentName, p.adapterType);
        if (!binding) {
          rpcError(RPC_ERRORS.NOT_FOUND, "Binding not found");
        }

        // Remove adapter
        await this.removeAdapter(binding.adapterToken);

        // Delete binding
        this.db.deleteBinding(agentName, p.adapterType);

        return { success: true };
      },

      "agent.refresh": async (params) => {
        const p = params as unknown as AgentRefreshParams;
        const token = requireToken(p.token);
        const principal = this.resolvePrincipal(token);
        this.assertOperationAllowed("agent.refresh", principal);

        // Check if agent exists
        const agent = this.db.getAgentByNameCaseInsensitive(p.agentName);
        if (!agent) {
          rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
        }

        // Refresh the session
        this.executor.requestSessionRefresh(agent.name, "rpc:agent.refresh");

        return { success: true, agentName: agent.name };
      },

      "agent.self": async (params) => {
        const p = params as unknown as AgentSelfParams;
        const agent = this.db.findAgentByToken(p.token);
        if (!agent) {
          rpcError(RPC_ERRORS.UNAUTHORIZED, "Invalid token");
        }

        this.db.updateAgentLastSeen(agent.name);

        const provider = agent.provider ?? "claude";
        const workspace = agent.workspace ?? process.cwd();
        const reasoningEffort = agent.reasoningEffort ?? "medium";
        const autoLevel = agent.autoLevel ?? "high";

        return {
          agent: {
            name: agent.name,
            provider,
            workspace,
            model: agent.model,
            reasoningEffort,
            autoLevel,
          },
        };
      },

      "agent.session-policy.set": async (params) => {
        const p = params as unknown as AgentSessionPolicySetParams;
        const token = requireToken(p.token);
        const principal = this.resolvePrincipal(token);
        this.assertOperationAllowed("agent.session-policy.set", principal);

        const agent = this.db.getAgentByNameCaseInsensitive(p.agentName);
        if (!agent) {
          rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
        }

        const clear = p.clear === true;

        const hasAnyUpdate =
          p.sessionDailyResetAt !== undefined ||
          p.sessionIdleTimeout !== undefined ||
          p.sessionMaxTokens !== undefined;

        if (!clear && !hasAnyUpdate) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "No session policy values provided");
        }

        let dailyResetAt: string | undefined;
        if (p.sessionDailyResetAt !== undefined) {
          if (typeof p.sessionDailyResetAt !== "string") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-daily-reset-at");
          }
          dailyResetAt = parseDailyResetAt(p.sessionDailyResetAt).normalized;
        }

        let idleTimeout: string | undefined;
        if (p.sessionIdleTimeout !== undefined) {
          if (typeof p.sessionIdleTimeout !== "string") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-idle-timeout");
          }
          parseDurationToMs(p.sessionIdleTimeout);
          idleTimeout = p.sessionIdleTimeout.trim();
        }

        let maxTokens: number | undefined;
        if (p.sessionMaxTokens !== undefined) {
          if (typeof p.sessionMaxTokens !== "number" || !Number.isFinite(p.sessionMaxTokens)) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-max-tokens");
          }
          if (p.sessionMaxTokens <= 0) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-max-tokens (must be > 0)");
          }
          maxTokens = Math.trunc(p.sessionMaxTokens);
        }

        const updated = this.db.updateAgentSessionPolicy(agent.name, {
          clear,
          dailyResetAt,
          idleTimeout,
          maxTokens,
        });

        return { success: true, agentName: agent.name, sessionPolicy: updated.sessionPolicy };
      },

      // Daemon methods
      "daemon.status": async (params) => {
        const p = params as unknown as { token: string };
        const token = requireToken(p.token);
        const principal = this.resolvePrincipal(token);
        this.assertOperationAllowed("daemon.status", principal);

        const bindings = this.db.listBindings();
        return {
          running: this.running,
          startTime: this.startTime?.toISOString(),
          debug: this.config.debug ?? false,
          adapters: Array.from(this.adapters.values()).map((a) => a.platform),
          bindings: bindings.map((b) => ({
            agentName: b.agentName,
            adapterType: b.adapterType,
          })),
          dataDir: this.config.dataDir,
        };
      },

      "daemon.ping": async (params) => {
        const p = params as unknown as { token: string };
        const token = requireToken(p.token);
        const principal = this.resolvePrincipal(token);
        this.assertOperationAllowed("daemon.ping", principal);

        return { pong: true, timestamp: new Date().toISOString() };
      },

      // Setup methods
      "setup.check": async () => {
        return { completed: this.db.isSetupComplete() };
      },

      "setup.execute": async (params) => {
        const p = params as unknown as SetupExecuteParams;

        // Check if setup is already complete
        if (this.db.isSetupComplete()) {
          rpcError(RPC_ERRORS.ALREADY_EXISTS, "Setup already completed");
        }

        // Setup agent home directories
        await setupAgentHome(p.agent.name, this.config.dataDir);

        // If an adapter is provided and the daemon is running, create/start it first.
        // This validates adapter credentials and avoids committing setup state if startup fails.
        const adapterToken = p.adapter?.adapterToken;
        const adapterType = p.adapter?.adapterType;
        const hadAdapterAlready = adapterToken ? this.adapters.has(adapterToken) : false;
        let createdAdapterForSetup = false;

        if (this.running && adapterToken && adapterType) {
          try {
            const adapter = await this.createAdapterForBinding(adapterType, adapterToken);
            if (!adapter) {
              rpcError(RPC_ERRORS.INVALID_PARAMS, `Unknown adapter type: ${adapterType}`);
            }
            createdAdapterForSetup = !hadAdapterAlready;
          } catch (err) {
            // Clean up any partially-created adapter on failure.
            if (!hadAdapterAlready) {
              await this.removeAdapter(adapterToken).catch(() => undefined);
            }
            throw err;
          }
        }

        let result: { agent: Agent; token: string };
        try {
          result = this.db.runInTransaction(() => {
            // Set boss name
            this.db.setBossName(p.bossName);

            // Set default provider
            this.db.setDefaultProvider(p.provider);

            // Create the first agent
            const agentResult = this.db.registerAgent({
              name: p.agent.name,
              description: p.agent.description,
              workspace: p.agent.workspace,
              provider: p.provider,
              model: p.agent.model,
              reasoningEffort: p.agent.reasoningEffort,
              autoLevel: p.agent.autoLevel,
            });

            // Create adapter binding if provided
            if (p.adapter) {
              this.db.createBinding(p.agent.name, p.adapter.adapterType, p.adapter.adapterToken);

              // Store boss ID for this adapter
              if (p.adapter.adapterBossId) {
                this.db.setAdapterBossId(p.adapter.adapterType, p.adapter.adapterBossId);
              }
            }

            // Set boss token
            this.db.setBossToken(p.bossToken);

            // Mark setup as complete
            this.db.markSetupComplete();

            return agentResult;
          });
        } catch (err) {
          // Roll back any adapter started during setup if DB commit fails.
          if (createdAdapterForSetup && adapterToken) {
            await this.removeAdapter(adapterToken).catch(() => undefined);
          }
          throw err;
        }

        // Register agent handler for auto-execution
        this.router.registerAgentHandler(p.agent.name, async () => {
          const currentAgent = this.db.getAgentByName(p.agent.name);
          if (!currentAgent) {
            console.error(`[Daemon] Agent ${p.agent.name} not found in database`);
            return;
          }

          this.executor.checkAndRun(currentAgent, this.db).catch((err) => {
            console.error(`[Daemon] Agent ${p.agent.name} run failed:`, err);
          });
        });

        return { agentToken: result.token };
      },

      // Boss methods
      "boss.verify": async (params) => {
        const p = params as unknown as BossVerifyParams;
        return { valid: this.db.verifyBossToken(p.token) };
      },
    };

    this.ipc.registerMethods(methods);
  }

  private async acquirePidFileLock(): Promise<void> {
    const dir = this.config.dataDir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const socketPath = getSocketPath(this.config);
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const fd = fs.openSync(this.pidPath, "wx");
        try {
          fs.writeFileSync(fd, String(process.pid), "utf-8");
        } finally {
          fs.closeSync(fd);
        }
        return;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "EEXIST") {
          throw err;
        }

        // PID file exists. If the socket is accepting connections, another daemon is running.
        const socketInUse = await this.isSocketAcceptingConnections(socketPath);
        if (socketInUse) {
          throw new Error("Daemon is already running");
        }

        // If the PID file is stale, remove it and retry.
        if (this.isPidFileStale()) {
          try {
            fs.unlinkSync(this.pidPath);
          } catch {
            // ignore
          }
          continue;
        }

        throw new Error("Daemon is already running");
      }
    }

    throw new Error("Daemon is already running");
  }

  private isPidFileStale(): boolean {
    let pid: number;
    try {
      const contents = fs.readFileSync(this.pidPath, "utf-8").trim();
      pid = parseInt(contents, 10);
      if (!Number.isFinite(pid)) return true;
    } catch {
      return true;
    }

    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }

    // Process exists; assume the daemon is running.
    return false;
  }

  private async isSocketAcceptingConnections(socketPath: string): Promise<boolean> {
    if (!fs.existsSync(socketPath)) return false;

    return new Promise((resolve) => {
      let resolved = false;
      const socket = net.createConnection({ path: socketPath });

      const finish = (result: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };

      const timer = setTimeout(() => finish(false), 200);

      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
  }

  private releasePidFileLock(): void {
    try {
      if (fs.existsSync(this.pidPath)) {
        fs.unlinkSync(this.pidPath);
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Check if daemon is running (socket-first, PID fallback).
 */
export async function isDaemonRunning(config: DaemonConfig = getDefaultConfig()): Promise<boolean> {
  const pidPath = path.join(config.dataDir, "daemon.pid");
  const socketPath = getSocketPath(config);

  // Prefer checking the socket directly; PID files can be stale or missing.
  if (await isSocketAcceptingConnections(socketPath)) {
    return true;
  }

  if (!fs.existsSync(pidPath)) {
    return false;
  }

  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8"), 10);
    // Check if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist, clean up stale PID file
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // ignore
    }
    return false;
  }
}

async function isSocketAcceptingConnections(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false;

  return new Promise((resolve) => {
    let resolved = false;
    const socket = net.createConnection({ path: socketPath });

    const finish = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), 200);

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Get socket path for IPC client.
 */
export function getSocketPath(config: DaemonConfig = getDefaultConfig()): string {
  return path.join(config.dataDir, "daemon.sock");
}
