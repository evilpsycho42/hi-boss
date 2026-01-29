import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { HiBossDatabase } from "./db/database.js";
import { IpcServer } from "./ipc/server.js";
import { MessageRouter } from "./router/message-router.js";
import { ChannelBridge } from "./bridges/channel-bridge.js";
import { AgentExecutor, createAgentExecutor } from "../agent/executor.js";
import type { Agent } from "../agent/types.js";
import { getAgentDir, setupAgentHome } from "../agent/home-setup.js";
import { EnvelopeScheduler } from "./scheduler/envelope-scheduler.js";
import type { RpcMethodRegistry } from "./ipc/types.js";
import {
  RPC_ERRORS,
  type EnvelopeSendParams,
  type EnvelopeListParams,
  type EnvelopeGetParams,
  type TurnPreviewParams,
  type AgentRegisterParams,
  type AgentBindParams,
  type AgentUnbindParams,
  type AgentRefreshParams,
  type AgentSelfParams,
  type AgentSessionPolicySetParams,
  type AgentSetParams,
  type SetupExecuteParams,
  type BossVerifyParams,
  type ReactionSetParams,
} from "./ipc/types.js";
import type { ChatAdapter } from "../adapters/types.js";
import { formatAgentAddress, parseAddress } from "../adapters/types.js";
import { TelegramAdapter } from "../adapters/telegram.adapter.js";
import { parseDateTimeInputToUtcIso, nowLocalIso } from "../shared/time.js";
import { parseDailyResetAt, parseDurationToMs } from "../shared/session-policy.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../shared/validation.js";
import { red } from "../shared/ansi.js";
import { ensureMemCliPrivateWorkspace, ensureMemCliPublicWorkspace } from "../shared/mem-cli.js";
import {
  DEFAULT_AGENT_AUTO_LEVEL,
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_REASONING_EFFORT,
  DEFAULT_ENVELOPE_LIST_BOX,
  getDefaultHiBossDir,
} from "../shared/defaults.js";
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
    dataDir: getDefaultHiBossDir(),
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
    return agent.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL;
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
      const disableAutoRun = process.env.HIBOSS_DISABLE_AGENT_AUTO_RUN === "1";
      if (disableAutoRun) {
        console.log(`[${nowLocalIso()}] [Daemon] Agent auto-run disabled (HIBOSS_DISABLE_AGENT_AUTO_RUN=1)`);
      } else {
        await this.registerAgentExecutionHandlers();
      }

      // Start all loaded adapters
      for (const adapter of this.adapters.values()) {
        await adapter.start();
      }

      // Start scheduler after adapters/handlers are ready
      this.scheduler.start();

      // Process any pending envelopes from before restart
      if (!disableAutoRun) {
        await this.processPendingEnvelopes();
      }
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
        console.log(
          red(`[${nowLocalIso()}] [Daemon] Session refresh requested for agent: ${enrichedCommand.agentName}`)
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
      const metadata: Record<string, unknown> = {};

      if (principal.kind === "boss") {
        if (typeof p.from !== "string" || !p.from.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Boss token requires from");
        }
        from = p.from.trim();
        fromBoss = p.fromBoss === true;

        if (typeof p.fromName === "string" && p.fromName.trim()) {
          metadata.fromName = p.fromName.trim();
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

      if (p.parseMode !== undefined) {
        if (typeof p.parseMode !== "string") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid parse-mode");
        }
        const mode = p.parseMode.trim();
        if (mode !== "plain" && mode !== "markdownv2" && mode !== "html") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid parse-mode (expected plain, markdownv2, or html)");
        }
        if (destination.type !== "channel") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "parse-mode is only supported for channel destinations");
        }
        metadata.parseMode = mode;
      }

      if (p.replyToMessageId !== undefined) {
        if (typeof p.replyToMessageId !== "string" || !p.replyToMessageId.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid reply-to-message-id");
        }
        if (destination.type !== "channel") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "reply-to-message-id is only supported for channel destinations");
        }
        metadata.replyToMessageId = p.replyToMessageId.trim();
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

      const finalMetadata = Object.keys(metadata).length > 0 ? metadata : undefined;

      try {
        const envelope = await this.router.routeEnvelope({
          from,
          to: p.to,
          fromBoss,
          content: {
            text: p.text,
            attachments: p.attachments,
          },
          deliverAt,
          metadata: finalMetadata,
        });

        this.scheduler.onEnvelopeCreated(envelope);
        return { id: envelope.id };
      } catch (err) {
        // Best-effort: ensure the scheduler sees newly-created scheduled envelopes, even if immediate delivery failed.
        const e = err as Error & { data?: unknown };
        if (e.data && typeof e.data === "object") {
          const id = (e.data as Record<string, unknown>).envelopeId;
          if (typeof id === "string" && id.trim()) {
            const env = this.db.getEnvelopeById(id.trim());
            if (env) {
              this.scheduler.onEnvelopeCreated(env);
            }
          }
        }
        throw err;
      }
    };

    const createReactionSet = (operation: string) => async (params: Record<string, unknown>) => {
      const p = params as unknown as ReactionSetParams;
      const token = requireToken(p.token);
      const principal = this.resolvePrincipal(token);
      this.assertOperationAllowed(operation, principal);

      if (principal.kind !== "agent") {
        rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
      }

      if (typeof p.to !== "string" || !p.to.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid to");
      }

      let destination: ReturnType<typeof parseAddress>;
      try {
        destination = parseAddress(p.to);
      } catch (err) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, err instanceof Error ? err.message : "Invalid to");
      }
      if (destination.type !== "channel") {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Reaction targets must be channel:<adapter>:<chat-id>");
      }

      if (typeof p.messageId !== "string" || !p.messageId.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid message-id");
      }
      if (typeof p.emoji !== "string" || !p.emoji.trim()) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid emoji");
      }

      const agent = principal.agent;
      this.db.updateAgentLastSeen(agent.name);

      const binding = this.db.getAgentBindingByType(agent.name, destination.adapter);
      if (!binding) {
        rpcError(
          RPC_ERRORS.UNAUTHORIZED,
          `Agent '${agent.name}' is not bound to adapter '${destination.adapter}'`
        );
      }

      const adapter = this.adapters.get(binding.adapterToken);
      if (!adapter) {
        rpcError(RPC_ERRORS.INTERNAL_ERROR, `Adapter not loaded: ${destination.adapter}`);
      }
      if (!adapter.setReaction) {
        rpcError(RPC_ERRORS.INVALID_PARAMS, `Adapter '${destination.adapter}' does not support reactions`);
      }

      await adapter.setReaction(destination.chatId, p.messageId.trim(), p.emoji.trim());
      return { success: true };
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
        box: p.box ?? DEFAULT_ENVELOPE_LIST_BOX,
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

    const createTurnPreview = (operation: string) => async (params: Record<string, unknown>) => {
      const p = params as unknown as TurnPreviewParams;
      const token = requireToken(p.token);
      const principal = this.resolvePrincipal(token);
      this.assertOperationAllowed(operation, principal);

      let agentName: string;
      if (principal.kind === "boss") {
        if (typeof p.agentName !== "string" || !p.agentName.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Boss token requires agentName");
        }
        const agent = this.db.getAgentByNameCaseInsensitive(p.agentName.trim());
        if (!agent) {
          rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
        }
        agentName = agent.name;
      } else {
        if (p.agentName !== undefined) {
          rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
        }
        this.db.updateAgentLastSeen(principal.agent.name);
        agentName = principal.agent.name;
      }

      let limit = 10;
      if (p.limit !== undefined) {
        if (typeof p.limit !== "number" || !Number.isFinite(p.limit)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit");
        }
        if (p.limit <= 0) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid limit (must be > 0)");
        }
        limit = Math.trunc(p.limit);
      }

      const envelopes = this.db.getPendingEnvelopesForAgent(agentName, limit);
      return { agentName, datetimeIso: new Date().toISOString(), envelopes };
    };

    const methods: RpcMethodRegistry = {
      // Envelope methods (canonical)
      "envelope.send": createEnvelopeSend("envelope.send"),
      "envelope.list": createEnvelopeList("envelope.list"),
      "envelope.get": createEnvelopeGet("envelope.get"),
      "turn.preview": createTurnPreview("turn.preview"),
      "reaction.set": createReactionSet("reaction.set"),

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

        let provider: "claude" | "codex" | undefined;
        if (p.provider !== undefined) {
          if (p.provider !== "claude" && p.provider !== "codex") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid provider (expected claude or codex)");
          }
          provider = p.provider;
        }

        let reasoningEffort: Agent["reasoningEffort"] | undefined;
        if (p.reasoningEffort !== undefined) {
          if (
            p.reasoningEffort !== "none" &&
            p.reasoningEffort !== "low" &&
            p.reasoningEffort !== "medium" &&
            p.reasoningEffort !== "high" &&
            p.reasoningEffort !== "xhigh"
          ) {
            rpcError(
              RPC_ERRORS.INVALID_PARAMS,
              "Invalid reasoning-effort (expected none, low, medium, high, xhigh)"
            );
          }
          reasoningEffort = p.reasoningEffort;
        }

        let autoLevel: Agent["autoLevel"] | undefined;
        if (p.autoLevel !== undefined) {
          if (p.autoLevel !== "low" && p.autoLevel !== "medium" && p.autoLevel !== "high") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid auto-level (expected low, medium, high)");
          }
          autoLevel = p.autoLevel;
        }

        let permissionLevel: "restricted" | "standard" | "privileged" | undefined;
        if (p.permissionLevel !== undefined) {
          if (
            p.permissionLevel !== "restricted" &&
            p.permissionLevel !== "standard" &&
            p.permissionLevel !== "privileged"
          ) {
            rpcError(
              RPC_ERRORS.INVALID_PARAMS,
              "Invalid permission-level (expected restricted, standard, privileged)"
            );
          }
          permissionLevel = p.permissionLevel;
        }

        let metadata: Record<string, unknown> | undefined;
        if (p.metadata !== undefined) {
          if (typeof p.metadata !== "object" || p.metadata === null || Array.isArray(p.metadata)) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid metadata (expected object)");
          }
          metadata = p.metadata;
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
          provider,
          model: typeof p.model === "string" && p.model.trim() ? p.model.trim() : undefined,
          reasoningEffort,
          autoLevel,
          permissionLevel,
          sessionPolicy: Object.keys(sessionPolicy).length > 0 ? sessionPolicy as any : undefined,
          metadata,
        });

        // Setup agent home directories
        await setupAgentHome(p.name, this.config.dataDir);

        // Initialize per-agent private memory workspace (best-effort)
        const memInit = ensureMemCliPrivateWorkspace(result.token, getAgentDir(p.name, this.config.dataDir));
        if (!memInit.ok && memInit.error) {
          console.error(`[Daemon] mem-cli private init failed for agent ${p.name}: ${memInit.error}`);
        }

        const bindAdapterType = p.bindAdapterType;
        const bindAdapterToken = p.bindAdapterToken;
        const wantsBind = bindAdapterType !== undefined || bindAdapterToken !== undefined;

        if (wantsBind) {
          if (typeof bindAdapterType !== "string" || !bindAdapterType.trim()) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid bind-adapter-type");
          }
          if (typeof bindAdapterToken !== "string" || !bindAdapterToken.trim()) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid bind-adapter-token");
          }

          const adapterType = bindAdapterType.trim();
          const adapterToken = bindAdapterToken.trim();

          const existingBinding = this.db.getBindingByAdapter(adapterType, adapterToken);
          if (existingBinding) {
            rpcError(
              RPC_ERRORS.ALREADY_EXISTS,
              `This ${adapterType} bot is already bound to agent '${existingBinding.agentName}'`
            );
          }

          const agentBinding = this.db.getAgentBindingByType(p.name, adapterType);
          if (agentBinding) {
            rpcError(RPC_ERRORS.ALREADY_EXISTS, `Agent '${p.name}' already has a ${adapterType} binding`);
          }

          const hadAdapterAlready = this.adapters.has(adapterToken);
          let createdAdapterForRegister = false;

          if (this.running) {
            try {
              const adapter = await this.createAdapterForBinding(adapterType, adapterToken);
              if (!adapter) {
                rpcError(RPC_ERRORS.INVALID_PARAMS, `Unknown adapter type: ${adapterType}`);
              }
              createdAdapterForRegister = !hadAdapterAlready;
            } catch (err) {
              if (!hadAdapterAlready) {
                await this.removeAdapter(adapterToken).catch(() => undefined);
              }
              throw err;
            }
          }

          try {
            this.db.createBinding(p.name, adapterType, adapterToken);
          } catch (err) {
            if (createdAdapterForRegister) {
              await this.removeAdapter(adapterToken).catch(() => undefined);
            }
            throw err;
          }
        }

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

        const provider = agent.provider ?? DEFAULT_AGENT_PROVIDER;
        const workspace = agent.workspace ?? process.cwd();
        const reasoningEffort = agent.reasoningEffort ?? DEFAULT_AGENT_REASONING_EFFORT;
        const autoLevel = agent.autoLevel ?? DEFAULT_AGENT_AUTO_LEVEL;

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

      "agent.set": async (params) => {
        const p = params as unknown as AgentSetParams;
        const token = requireToken(p.token);
        const principal = this.resolvePrincipal(token);
        this.assertOperationAllowed("agent.set", principal);

        if (typeof p.agentName !== "string" || !p.agentName.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid agent-name");
        }

        const agent = this.db.getAgentByNameCaseInsensitive(p.agentName.trim());
        if (!agent) {
          rpcError(RPC_ERRORS.NOT_FOUND, "Agent not found");
        }
        const agentName = agent.name;

        const wantsBind = p.bindAdapterType !== undefined || p.bindAdapterToken !== undefined;
        const wantsUnbind = p.unbindAdapterType !== undefined;

        const hasAnyUpdate =
          p.description !== undefined ||
          p.workspace !== undefined ||
          p.provider !== undefined ||
          p.model !== undefined ||
          p.reasoningEffort !== undefined ||
          p.autoLevel !== undefined ||
          p.permissionLevel !== undefined ||
          p.sessionPolicy !== undefined ||
          p.metadata !== undefined ||
          wantsBind ||
          wantsUnbind;

        if (!hasAnyUpdate) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "No updates provided");
        }

        if (wantsBind) {
          if (typeof p.bindAdapterType !== "string" || !p.bindAdapterType.trim()) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid bind-adapter-type");
          }
          if (typeof p.bindAdapterToken !== "string" || !p.bindAdapterToken.trim()) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid bind-adapter-token");
          }
        }

        if (wantsUnbind) {
          if (typeof p.unbindAdapterType !== "string" || !p.unbindAdapterType.trim()) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid unbind-adapter-type");
          }
        }

        if (wantsBind && wantsUnbind) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Cannot bind and unbind in the same request");
        }

        let provider: "claude" | "codex" | null | undefined;
        if (p.provider !== undefined) {
          if (p.provider !== null && p.provider !== "claude" && p.provider !== "codex") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid provider (expected claude or codex)");
          }
          provider = p.provider;
        }

        let reasoningEffort: Agent["reasoningEffort"] | null | undefined;
        if (p.reasoningEffort !== undefined) {
          if (
            p.reasoningEffort !== null &&
            p.reasoningEffort !== "none" &&
            p.reasoningEffort !== "low" &&
            p.reasoningEffort !== "medium" &&
            p.reasoningEffort !== "high" &&
            p.reasoningEffort !== "xhigh"
          ) {
            rpcError(
              RPC_ERRORS.INVALID_PARAMS,
              "Invalid reasoning-effort (expected none, low, medium, high, xhigh)"
            );
          }
          reasoningEffort = p.reasoningEffort;
        }

        let autoLevel: Agent["autoLevel"] | null | undefined;
        if (p.autoLevel !== undefined) {
          if (p.autoLevel !== null && p.autoLevel !== "low" && p.autoLevel !== "medium" && p.autoLevel !== "high") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid auto-level (expected low, medium, high)");
          }
          autoLevel = p.autoLevel;
        }

        let permissionLevel: "restricted" | "standard" | "privileged" | undefined;
        if (p.permissionLevel !== undefined) {
          if (principal.kind !== "boss") {
            rpcError(RPC_ERRORS.UNAUTHORIZED, "Access denied");
          }
          if (
            p.permissionLevel !== "restricted" &&
            p.permissionLevel !== "standard" &&
            p.permissionLevel !== "privileged"
          ) {
            rpcError(
              RPC_ERRORS.INVALID_PARAMS,
              "Invalid permission-level (expected restricted, standard, privileged)"
            );
          }
          permissionLevel = p.permissionLevel;
        }

        let sessionPolicyUpdate:
          | { clear: true }
          | { dailyResetAt?: string; idleTimeout?: string; maxTokens?: number }
          | undefined;
        if (p.sessionPolicy !== undefined) {
          if (p.sessionPolicy === null) {
            sessionPolicyUpdate = { clear: true };
          } else if (typeof p.sessionPolicy === "object" && p.sessionPolicy !== null && !Array.isArray(p.sessionPolicy)) {
            const raw = p.sessionPolicy as Record<string, unknown>;
            const next: { dailyResetAt?: string; idleTimeout?: string; maxTokens?: number } = {};

            if (raw.dailyResetAt !== undefined) {
              if (typeof raw.dailyResetAt !== "string") {
                rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.daily-reset-at");
              }
              next.dailyResetAt = parseDailyResetAt(raw.dailyResetAt).normalized;
            }

            if (raw.idleTimeout !== undefined) {
              if (typeof raw.idleTimeout !== "string") {
                rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.idle-timeout");
              }
              parseDurationToMs(raw.idleTimeout);
              next.idleTimeout = raw.idleTimeout.trim();
            }

            if (raw.maxTokens !== undefined) {
              if (typeof raw.maxTokens !== "number" || !Number.isFinite(raw.maxTokens)) {
                rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.max-tokens");
              }
              if (raw.maxTokens <= 0) {
                rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.max-tokens (must be > 0)");
              }
              next.maxTokens = Math.trunc(raw.maxTokens);
            }

            if (Object.keys(next).length === 0) {
              rpcError(RPC_ERRORS.INVALID_PARAMS, "No session policy values provided");
            }

            sessionPolicyUpdate = next;
          } else {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy (expected object or null)");
          }
        }

        let metadata: Record<string, unknown> | null | undefined;
        if (p.metadata !== undefined) {
          if (p.metadata === null) {
            metadata = null;
          } else if (typeof p.metadata === "object" && p.metadata !== null && !Array.isArray(p.metadata)) {
            metadata = p.metadata;
          } else {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid metadata (expected object or null)");
          }
        }

        const before = this.db.getAgentByName(agentName)!;

        // Bind/unbind are async due to adapter start/stop; do those outside the DB transaction.
        if (wantsUnbind) {
          const adapterType = (p.unbindAdapterType as string).trim();
          const binding = this.db.getAgentBindingByType(agentName, adapterType);
          if (!binding) {
            rpcError(RPC_ERRORS.NOT_FOUND, "Binding not found");
          }

          await this.removeAdapter(binding.adapterToken);
          this.db.deleteBinding(agentName, adapterType);
        }

        if (wantsBind) {
          const adapterType = (p.bindAdapterType as string).trim();
          const adapterToken = (p.bindAdapterToken as string).trim();

          const existingBinding = this.db.getBindingByAdapter(adapterType, adapterToken);
          if (existingBinding && existingBinding.agentName !== agentName) {
            rpcError(
              RPC_ERRORS.ALREADY_EXISTS,
              `This ${adapterType} bot is already bound to agent '${existingBinding.agentName}'`
            );
          }

          const agentBinding = this.db.getAgentBindingByType(agentName, adapterType);
          if (agentBinding) {
            rpcError(RPC_ERRORS.ALREADY_EXISTS, `Agent '${agentName}' already has a ${adapterType} binding`);
          }

          const hadAdapterAlready = this.adapters.has(adapterToken);
          let createdAdapterForSet = false;

          if (this.running) {
            try {
              const adapter = await this.createAdapterForBinding(adapterType, adapterToken);
              if (!adapter) {
                rpcError(RPC_ERRORS.INVALID_PARAMS, `Unknown adapter type: ${adapterType}`);
              }
              createdAdapterForSet = !hadAdapterAlready;
            } catch (err) {
              if (!hadAdapterAlready) {
                await this.removeAdapter(adapterToken).catch(() => undefined);
              }
              throw err;
            }
          }

          try {
            this.db.createBinding(agentName, adapterType, adapterToken);
          } catch (err) {
            if (createdAdapterForSet) {
              await this.removeAdapter(adapterToken).catch(() => undefined);
            }
            throw err;
          }
        }

        const updates: {
          description?: string | null;
          workspace?: string | null;
          provider?: "claude" | "codex" | null;
          model?: string | null;
          reasoningEffort?: Agent["reasoningEffort"] | null;
          autoLevel?: Agent["autoLevel"] | null;
        } = {};

        if (p.description !== undefined) {
          if (p.description !== null && typeof p.description !== "string") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid description");
          }
          const trimmed = typeof p.description === "string" ? p.description.trim() : null;
          updates.description = trimmed && trimmed.length > 0 ? trimmed : null;
        }

        if (p.workspace !== undefined) {
          if (p.workspace !== null && typeof p.workspace !== "string") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid workspace");
          }
          const trimmed = typeof p.workspace === "string" ? p.workspace.trim() : null;
          updates.workspace = trimmed && trimmed.length > 0 ? trimmed : null;
        }

        if (provider !== undefined) {
          updates.provider = provider;
        }

        if (p.model !== undefined) {
          if (p.model !== null && typeof p.model !== "string") {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid model");
          }
          const trimmed = typeof p.model === "string" ? p.model.trim() : null;
          updates.model = trimmed && trimmed.length > 0 ? trimmed : null;
        }

        if (reasoningEffort !== undefined) {
          updates.reasoningEffort = reasoningEffort;
        }

        if (autoLevel !== undefined) {
          updates.autoLevel = autoLevel;
        }

        this.db.runInTransaction(() => {
          if (Object.keys(updates).length > 0) {
            this.db.updateAgentFields(agentName, updates);
          }

          if (permissionLevel !== undefined) {
            this.db.setAgentPermissionLevel(agentName, permissionLevel);
          }

          if (sessionPolicyUpdate !== undefined) {
            if ("clear" in sessionPolicyUpdate) {
              this.db.updateAgentSessionPolicy(agentName, { clear: true });
            } else {
              this.db.updateAgentSessionPolicy(agentName, sessionPolicyUpdate);
            }
          }

          if (metadata !== undefined) {
            this.db.updateAgentMetadata(agentName, metadata);
          }
        });

        const updated = this.db.getAgentByName(agentName)!;
        const bindings = this.db.getBindingsByAgentName(agentName).map((b) => b.adapterType);

        const needsRefresh =
          (provider !== undefined && before.provider !== updated.provider) ||
          (p.model !== undefined && before.model !== updated.model) ||
          (reasoningEffort !== undefined && before.reasoningEffort !== updated.reasoningEffort) ||
          (autoLevel !== undefined && before.autoLevel !== updated.autoLevel) ||
          (p.workspace !== undefined && before.workspace !== updated.workspace);

        if (needsRefresh) {
          this.executor.requestSessionRefresh(agentName, "rpc:agent.set");
        }

        return {
          success: true,
          agent: {
            name: updated.name,
            description: updated.description,
            workspace: updated.workspace,
            provider: updated.provider ?? DEFAULT_AGENT_PROVIDER,
            model: updated.model,
            reasoningEffort: updated.reasoningEffort ?? DEFAULT_AGENT_REASONING_EFFORT,
            autoLevel: updated.autoLevel ?? DEFAULT_AGENT_AUTO_LEVEL,
            permissionLevel: updated.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL,
            sessionPolicy: updated.sessionPolicy,
            metadata: updated.metadata,
          },
          bindings,
        };
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

        if (typeof p.bossName !== "string" || !p.bossName.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid boss-name");
        }

        if (typeof p.agent.name !== "string" || !isValidAgentName(p.agent.name)) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, AGENT_NAME_ERROR_MESSAGE);
        }

        if (
          p.agent.reasoningEffort !== "low" &&
          p.agent.reasoningEffort !== "medium" &&
          p.agent.reasoningEffort !== "high"
        ) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid reasoning-effort (expected low, medium, high)");
        }

        if (p.agent.autoLevel !== "low" && p.agent.autoLevel !== "medium" && p.agent.autoLevel !== "high") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid auto-level (expected low, medium, high)");
        }

        if (p.agent.permissionLevel !== undefined) {
          if (
            p.agent.permissionLevel !== "restricted" &&
            p.agent.permissionLevel !== "standard" &&
            p.agent.permissionLevel !== "privileged"
          ) {
            rpcError(
              RPC_ERRORS.INVALID_PARAMS,
              "Invalid permission-level (expected restricted, standard, privileged)"
            );
          }
        }

        if (p.agent.sessionPolicy !== undefined) {
          if (typeof p.agent.sessionPolicy !== "object" || p.agent.sessionPolicy === null) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy (expected object)");
          }

          const sp = p.agent.sessionPolicy as Record<string, unknown>;
          if (sp.dailyResetAt !== undefined) {
            if (typeof sp.dailyResetAt !== "string") {
              rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.daily-reset-at");
            }
            sp.dailyResetAt = parseDailyResetAt(sp.dailyResetAt).normalized;
          }
          if (sp.idleTimeout !== undefined) {
            if (typeof sp.idleTimeout !== "string") {
              rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.idle-timeout");
            }
            parseDurationToMs(sp.idleTimeout);
            sp.idleTimeout = sp.idleTimeout.trim();
          }
          if (sp.maxTokens !== undefined) {
            if (typeof sp.maxTokens !== "number" || !Number.isFinite(sp.maxTokens)) {
              rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.max-tokens");
            }
            if (sp.maxTokens <= 0) {
              rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid session-policy.max-tokens (must be > 0)");
            }
            sp.maxTokens = Math.trunc(sp.maxTokens);
          }
        }

        if (p.agent.metadata !== undefined) {
          if (typeof p.agent.metadata !== "object" || p.agent.metadata === null || Array.isArray(p.agent.metadata)) {
            rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid metadata (expected object)");
          }
        }

        if (p.adapter.adapterType !== "telegram") {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid adapter-type (expected telegram)");
        }
        if (typeof p.adapter.adapterToken !== "string" || !p.adapter.adapterToken.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid adapter-token");
        }
        if (typeof p.adapter.adapterBossId !== "string" || !p.adapter.adapterBossId.trim()) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid adapter-boss-id");
        }

        if (typeof p.bossToken !== "string" || p.bossToken.trim().length < 4) {
          rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid boss-token (must be at least 4 characters)");
        }

        // Setup agent home directories
        await setupAgentHome(p.agent.name, this.config.dataDir);

        // If an adapter is provided and the daemon is running, create/start it first.
        // This validates adapter credentials and avoids committing setup state if startup fails.
        const adapterToken = p.adapter.adapterToken.trim();
        const adapterType = p.adapter.adapterType.trim();
        const hadAdapterAlready = this.adapters.has(adapterToken);
        let createdAdapterForSetup = false;

        if (this.running) {
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
              permissionLevel: p.agent.permissionLevel,
              sessionPolicy: p.agent.sessionPolicy,
              metadata: p.agent.metadata,
            });

            // Create adapter binding if provided
            this.db.createBinding(p.agent.name, p.adapter.adapterType, p.adapter.adapterToken);

            // Store boss ID for this adapter
            this.db.setAdapterBossId(p.adapter.adapterType, p.adapter.adapterBossId.trim().replace(/^@/, ""));

            // Set boss token
            this.db.setBossToken(p.bossToken.trim());

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

        // Initialize public + per-agent private memory workspaces (best-effort)
        const publicInit = ensureMemCliPublicWorkspace();
        if (!publicInit.ok && publicInit.error) {
          console.error(`[Daemon] mem-cli public init failed during setup: ${publicInit.error}`);
        }
        const privateInit = ensureMemCliPrivateWorkspace(result.token, getAgentDir(p.agent.name, this.config.dataDir));
        if (!privateInit.ok && privateInit.error) {
          console.error(`[Daemon] mem-cli private init failed during setup for agent ${p.agent.name}: ${privateInit.error}`);
        }

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
