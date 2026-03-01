/**
 * Agent executor for running agent sessions with direct CLI invocation.
 */
import type { ChildProcess } from "node:child_process";
import type { Agent } from "./types.js";
import type { HiBossDatabase } from "../daemon/db/database.js";
import type { Envelope } from "../envelope/types.js";
import { parseAddress } from "../adapters/types.js";
import { getHiBossDir } from "./home-setup.js";
import { buildTurnInput } from "./turn-input.js";
import {
  parseSessionPolicyConfig,
} from "../shared/session-policy.js";
import { AsyncSemaphore } from "../shared/async-semaphore.js";
import {
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_SESSION_CONCURRENCY_GLOBAL,
  DEFAULT_SESSION_CONCURRENCY_PER_AGENT,
} from "../shared/defaults.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import { INTERNAL_VERSION } from "../shared/version.js";
import {
  getRefreshReasonForPolicy,
  getBossInfo,
  queueAgentTask,
  type AgentSession,
  type SessionRefreshRequest,
} from "./executor-support.js";
import { writePersistedAgentSession } from "./persisted-session.js";
import type { AgentRunTrigger } from "./executor-triggers.js";
import { getTriggerFields } from "./executor-triggers.js";
import { countDuePendingEnvelopesForAgent } from "./executor-db.js";
import { executeCliTurn } from "./executor-turn.js";
import { getOrCreateAgentSession } from "./executor-session.js";
import { getProviderCliEnvOverrides } from "./provider-env.js";
import type { ConversationHistory } from "../daemon/history/conversation-history.js";
import { closeAllActiveSessions, closeSessionByPath } from "../daemon/history/session-close.js";
import { writeAgentRunTrace } from "../shared/agent-run-trace.js";
import { generateSystemInstructions } from "./instruction-generator.js";
import { buildAgentTeamPromptContext, resolveAgentWorkspace } from "../team/runtime.js";

/**
 * Maximum number of pending envelopes to process in a single turn.
 */
const MAX_ENVELOPES_PER_TURN = 10;

type InFlightAgentRun = {
  runRecordId: string;
  abortController: AbortController;
  childProcess: ChildProcess | null;
  abortReason?: string;
};

type RunCompletionState = "success" | "failed" | "cancelled";

type SessionExecutionScope =
  | {
      kind: "default";
      cacheKey: string;
    }
  | {
      kind: "channel";
      cacheKey: string;
      agentSessionId: string;
      adapterType: string;
      chatId: string;
      ownerUserId?: string;
    }
  | {
      kind: "pinned";
      cacheKey: string;
      agentSessionId: string;
    };

type AgentRunStartedHook = (params: {
  agentName: string;
  runId: string;
  envelopes: Envelope[];
  db: HiBossDatabase;
}) => void | Promise<void>;

type AgentRunFinishedHook = (params: {
  agentName: string;
  runId: string;
  envelopes: Envelope[];
  db: HiBossDatabase;
  state: RunCompletionState;
  error?: string;
}) => void | Promise<void>;

type CapturedRunTrace = {
  provider: "claude" | "codex";
  status: "success" | "failed" | "cancelled";
  entries: Array<{ type: "assistant" | "tool-call"; text: string; toolName?: string }>;
  error?: string;
};

/**
 * Agent executor manages agent sessions and runs.
 */
export class AgentExecutor {
  private sessions: Map<string, AgentSession> = new Map(); // default:<agent>
  private channelSessions: Map<string, AgentSession> = new Map(); // channel-session:<agent>:<session-id> | agent-session:<agent>:<session-id>
  private agentDispatchLocks: Map<string, Promise<void>> = new Map();
  private sessionLocks: Map<string, Promise<void>> = new Map();
  private inFlightRuns: Map<string, Set<InFlightAgentRun>> = new Map();
  private agentQueuedTaskCount: Map<string, number> = new Map();
  private globalRunSemaphore: AsyncSemaphore = new AsyncSemaphore(DEFAULT_SESSION_CONCURRENCY_GLOBAL);
  private perAgentRunSemaphores: Map<string, AsyncSemaphore> = new Map();
  private abortGenerationByAgent: Map<string, number> = new Map();
  private concurrencyPerAgent: number = DEFAULT_SESSION_CONCURRENCY_PER_AGENT;
  private concurrencyGlobal: number = DEFAULT_SESSION_CONCURRENCY_GLOBAL;
  private pendingSessionRefresh: Map<string, SessionRefreshRequest> = new Map();
  private pendingSessionContextReload: Map<string, SessionRefreshRequest> = new Map();
  private db: HiBossDatabase | null;
  private hibossDir: string;
  private conversationHistory: ConversationHistory | null;
  private onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;
  private onRunStarted?: AgentRunStartedHook;
  private onRunFinished?: AgentRunFinishedHook;

  constructor(
    options: {
      db?: HiBossDatabase;
      hibossDir?: string;
      conversationHistory?: ConversationHistory;
      onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;
      onRunStarted?: AgentRunStartedHook;
      onRunFinished?: AgentRunFinishedHook;
      sessionConcurrencyPerAgent?: number;
      sessionConcurrencyGlobal?: number;
    } = {}
  ) {
    this.db = options.db ?? null;
    this.hibossDir = options.hibossDir ?? getHiBossDir();
    this.conversationHistory = options.conversationHistory ?? null;
    this.onEnvelopesDone = options.onEnvelopesDone;
    this.onRunStarted = options.onRunStarted;
    this.onRunFinished = options.onRunFinished;
    this.setConcurrencyLimits({
      perAgent: options.sessionConcurrencyPerAgent ?? DEFAULT_SESSION_CONCURRENCY_PER_AGENT,
      global: options.sessionConcurrencyGlobal ?? DEFAULT_SESSION_CONCURRENCY_GLOBAL,
    });
  }

  setConcurrencyLimits(input: { perAgent: number; global: number }): void {
    const perAgent = Math.max(1, Math.min(64, Math.trunc(input.perAgent)));
    const global = Math.max(perAgent, Math.min(256, Math.trunc(input.global)));
    this.concurrencyPerAgent = perAgent;
    this.concurrencyGlobal = global;
    this.globalRunSemaphore.setCapacity(global);
    for (const semaphore of this.perAgentRunSemaphores.values()) {
      semaphore.setCapacity(perAgent);
    }
  }

  private getAgentSemaphore(agentName: string): AsyncSemaphore {
    const existing = this.perAgentRunSemaphores.get(agentName);
    if (existing) return existing;
    const semaphore = new AsyncSemaphore(this.concurrencyPerAgent);
    this.perAgentRunSemaphores.set(agentName, semaphore);
    return semaphore;
  }

  private incrementAgentTaskCount(agentName: string): void {
    const n = this.agentQueuedTaskCount.get(agentName) ?? 0;
    this.agentQueuedTaskCount.set(agentName, n + 1);
  }

  private decrementAgentTaskCount(agentName: string): void {
    const n = this.agentQueuedTaskCount.get(agentName) ?? 0;
    if (n <= 1) {
      this.agentQueuedTaskCount.delete(agentName);
      return;
    }
    this.agentQueuedTaskCount.set(agentName, n - 1);
  }

  private getAbortGeneration(agentName: string): number {
    return this.abortGenerationByAgent.get(agentName) ?? 0;
  }

  private bumpAbortGeneration(agentName: string): number {
    const next = this.getAbortGeneration(agentName) + 1;
    this.abortGenerationByAgent.set(agentName, next);
    return next;
  }

  private isAbortGenerationCurrent(agentName: string, expected: number): boolean {
    return this.getAbortGeneration(agentName) === expected;
  }

  private buildDefaultSessionKey(agentName: string): string {
    return `default:${agentName}`;
  }

  private buildChannelSessionKey(agentName: string, sessionId: string): string {
    return `channel-session:${agentName}:${sessionId}`;
  }

  private buildPinnedSessionKey(agentName: string, sessionId: string): string {
    return `agent-session:${agentName}:${sessionId}`;
  }

  invalidateChannelSessionCache(agentName: string, adapterType: string, chatId: string): void {
    void adapterType;
    void chatId;
    for (const key of [...this.channelSessions.keys()]) {
      if (key.startsWith(`channel-session:${agentName}:`)) {
        this.channelSessions.delete(key);
      }
    }
  }

  /**
   * True if the daemon currently has a queued or in-flight task for this agent.
   */
  isAgentBusy(agentName: string): boolean {
    if (this.agentDispatchLocks.has(agentName)) return true;
    if ((this.agentQueuedTaskCount.get(agentName) ?? 0) > 0) return true;
    const inFlight = this.inFlightRuns.get(agentName);
    return Boolean(inFlight && inFlight.size > 0);
  }

  /**
   * Cancel the current in-flight run for an agent (best-effort).
   */
  abortCurrentRun(agentName: string, reason: string): boolean {
    this.bumpAbortGeneration(agentName);
    const set = this.inFlightRuns.get(agentName);
    const hadQueuedTasks = (this.agentQueuedTaskCount.get(agentName) ?? 0) > 0;
    if (!set || set.size === 0) return hadQueuedTasks;

    for (const inFlight of set) {
      if (!inFlight.abortReason) {
        inFlight.abortReason = reason;
      }
      inFlight.abortController.abort();

      if (inFlight.childProcess) {
        try {
          if (inFlight.childProcess.pid) {
            process.kill(-inFlight.childProcess.pid, "SIGTERM");
          } else {
            inFlight.childProcess.kill("SIGTERM");
          }
        } catch {
          try {
            inFlight.childProcess.kill("SIGTERM");
          } catch {
            // best-effort
          }
        }
      }
    }

    return true;
  }

  /**
   * Request a session refresh for an agent.
   */
  requestSessionRefresh(agentName: string, reason: string): void {
    const existing = this.pendingSessionRefresh.get(agentName);
    if (existing) {
      existing.reasons.push(reason);
    } else {
      this.pendingSessionRefresh.set(agentName, {
        requestedAtMs: Date.now(),
        reasons: [reason],
      });
    }

    queueAgentTask({
      agentLocks: this.agentDispatchLocks,
      agentName,
      log: () => undefined,
      task: async () => {
        await this.applyPendingSessionRefresh(agentName);
      },
    }).catch((err) => {
      logEvent("error", "agent-session-remove-queue-failed", {
        "agent-name": agentName,
        error: errorMessage(err),
      });
    });
  }

  /**
   * Request a hot reload of session context (team/workspace prompt context) for an agent.
   *
   * This does not reset provider sessions or conversation history; it only updates
   * in-memory session instructions/workspace for subsequent turns.
   */
  requestSessionContextReload(agentName: string, reason: string): void {
    const existing = this.pendingSessionContextReload.get(agentName);
    if (existing) {
      existing.reasons.push(reason);
    } else {
      this.pendingSessionContextReload.set(agentName, {
        requestedAtMs: Date.now(),
        reasons: [reason],
      });
    }

    queueAgentTask({
      agentLocks: this.agentDispatchLocks,
      agentName,
      log: () => undefined,
      task: async () => {
        await this.applyPendingSessionContextReload(agentName);
      },
    }).catch((err) => {
      logEvent("error", "agent-session-context-reload-queue-failed", {
        "agent-name": agentName,
        error: errorMessage(err),
      });
    });
  }

  private getSessionPolicy(agent: Agent) {
    return parseSessionPolicyConfig(agent.sessionPolicy, { strict: false });
  }

  private getAndClearPendingRefreshReasons(agentName: string): string[] {
    const pending = this.pendingSessionRefresh.get(agentName);
    if (!pending) return [];
    this.pendingSessionRefresh.delete(agentName);
    return pending.reasons;
  }

  private async applyPendingSessionRefresh(agentName: string): Promise<string[]> {
    const reasons = this.getAndClearPendingRefreshReasons(agentName);
    if (reasons.length === 0) return [];
    await this.refreshSession(agentName, reasons.join(","));
    return reasons;
  }

  private getAndClearPendingSessionContextReloadReasons(agentName: string): string[] {
    const pending = this.pendingSessionContextReload.get(agentName);
    if (!pending) return [];
    this.pendingSessionContextReload.delete(agentName);
    return pending.reasons;
  }

  private async applyPendingSessionContextReload(agentName: string): Promise<string[]> {
    const reasons = this.getAndClearPendingSessionContextReloadReasons(agentName);
    if (reasons.length === 0) return [];
    await this.reloadSessionContext(agentName, reasons.join(","));
    return reasons;
  }

  private async reloadSessionContext(agentName: string, reason?: string): Promise<void> {
    const db = this.db;
    if (!db) return;

    const agent = db.getAgentByNameCaseInsensitive(agentName);
    if (!agent) return;

    const defaultSession = this.sessions.get(agent.name);
    const scopedSessionKeys = [...this.channelSessions.keys()].filter((key) => (
      key.startsWith(`channel-session:${agent.name}:`) ||
      key.startsWith(`agent-session:${agent.name}:`)
    ));
    if (!defaultSession && scopedSessionKeys.length === 0) {
      return;
    }

    const agentRecord = db.getAgentByName(agent.name);
    if (!agentRecord) return;

    const workspace = resolveAgentWorkspace({
      db,
      hibossDir: this.hibossDir,
      agent,
    });
    const bindings = db.getBindingsByAgentName(agent.name);
    const boss = getBossInfo(db, bindings);
    const teams = buildAgentTeamPromptContext({
      db,
      hibossDir: this.hibossDir,
      agent,
    });
    const instructions = generateSystemInstructions({
      agent,
      agentToken: agentRecord.token,
      bindings,
      workspaceDir: workspace,
      bossTimezone: db.getBossTimezone(),
      hibossDir: this.hibossDir,
      boss,
      teams,
    });

    let updatedCount = 0;
    if (defaultSession) {
      defaultSession.systemInstructions = instructions;
      defaultSession.workspace = workspace;
      updatedCount += 1;
    }
    for (const key of scopedSessionKeys) {
      const scoped = this.channelSessions.get(key);
      if (!scoped) continue;
      scoped.systemInstructions = instructions;
      scoped.workspace = workspace;
      updatedCount += 1;
    }

    logEvent("info", "agent-session-context-reload", {
      "agent-name": agent.name,
      reason,
      "updated-session-count": updatedCount,
      state: "success",
    });
  }

  /**
   * Check and dispatch pending envelopes for session-scoped execution.
   */
  async checkAndRun(agent: Agent, db: HiBossDatabase, trigger?: AgentRunTrigger): Promise<void> {
    await queueAgentTask({
      agentLocks: this.agentDispatchLocks,
      agentName: agent.name,
      log: () => undefined,
      task: async () => {
        await this.dispatchPendingEnvelopes(agent, db, trigger);
      },
    });
  }

  private async dispatchPendingEnvelopes(agent: Agent, db: HiBossDatabase, trigger?: AgentRunTrigger): Promise<void> {
    const DISPATCH_LIMIT = Math.max(MAX_ENVELOPES_PER_TURN, 50);
    const pendingRefreshReasons = await this.applyPendingSessionRefresh(agent.name);

    while (true) {
      const envelopes = db.getPendingEnvelopesForAgent(agent.name, DISPATCH_LIMIT);
      if (envelopes.length === 0) return;

      const envelopeIds = envelopes.map((item) => item.id);
      db.markEnvelopesDone(envelopeIds, {
        reason: "executor-read-batch",
        origin: "internal",
        outcome: "queued-for-execution",
      });
      for (const env of envelopes) {
        env.status = "done";
      }
      if (this.onEnvelopesDone) {
        try {
          await this.onEnvelopesDone(envelopeIds, db);
        } catch (err) {
          logEvent("error", "agent-on-envelopes-done-failed", {
            "agent-name": agent.name,
            error: errorMessage(err),
          });
        }
      }

      const grouped = new Map<string, { scope: SessionExecutionScope; envelopes: Envelope[] }>();
      for (const env of envelopes) {
        const scope = this.resolveExecutionScope(agent, db, env);
        const existing = grouped.get(scope.cacheKey);
        if (existing) {
          existing.envelopes.push(env);
        } else {
          grouped.set(scope.cacheKey, { scope, envelopes: [env] });
        }
      }

      for (const { scope, envelopes: group } of grouped.values()) {
        for (let i = 0; i < group.length; i += MAX_ENVELOPES_PER_TURN) {
          this.queueSessionExecution({
            agent,
            db,
            scope,
            envelopes: group.slice(i, i + MAX_ENVELOPES_PER_TURN),
            trigger,
            refreshReasons: pendingRefreshReasons,
          });
        }
      }

      if (envelopes.length < DISPATCH_LIMIT) {
        return;
      }
    }
  }

  private resolveExecutionScope(agent: Agent, db: HiBossDatabase, envelope: Envelope): SessionExecutionScope {
    const metadata = envelope.metadata as Record<string, unknown> | undefined;
    const pinnedTargetSessionId =
      typeof metadata?.targetSessionId === "string" && metadata.targetSessionId.trim().length > 0
        ? metadata.targetSessionId.trim()
        : undefined;
    if (pinnedTargetSessionId) {
      const pinnedSession = db.getAgentSessionById(pinnedTargetSessionId);
      if (pinnedSession && pinnedSession.agentName === agent.name) {
        return {
          kind: "pinned",
          cacheKey: this.buildPinnedSessionKey(agent.name, pinnedSession.id),
          agentSessionId: pinnedSession.id,
        };
      }
    }

    const parsedFrom = (() => {
      try {
        return parseAddress(envelope.from);
      } catch {
        return null;
      }
    })();

    if (parsedFrom && parsedFrom.type === "channel") {
      const provider = agent.provider ?? DEFAULT_AGENT_PROVIDER;
      const md = metadata;
      const ownerUserId = typeof md?.userToken === "string" && md.userToken.trim()
        ? md.userToken.trim()
        : undefined;
      const pinnedSessionId = typeof md?.channelSessionId === "string" && md.channelSessionId.trim().length > 0
        ? md.channelSessionId.trim()
        : undefined;

      if (pinnedSessionId) {
        const pinnedSession = db.getAgentSessionById(pinnedSessionId);
        if (pinnedSession && pinnedSession.agentName === agent.name) {
          return {
            kind: "channel",
            cacheKey: this.buildChannelSessionKey(agent.name, pinnedSession.id),
            agentSessionId: pinnedSession.id,
            adapterType: parsedFrom.adapter,
            chatId: parsedFrom.chatId,
            ownerUserId,
          };
        }
      }

      const defaultSession = db.getOrCreateChannelDefaultSession({
        agentName: agent.name,
        adapterType: parsedFrom.adapter,
        chatId: parsedFrom.chatId,
        ownerUserId,
        provider,
      });

      return {
        kind: "channel",
        cacheKey: this.buildChannelSessionKey(agent.name, defaultSession.session.id),
        agentSessionId: defaultSession.session.id,
        adapterType: parsedFrom.adapter,
        chatId: parsedFrom.chatId,
        ownerUserId,
      };
    }

    return {
      kind: "default",
      cacheKey: this.buildDefaultSessionKey(agent.name),
    };
  }

  private queueSessionExecution(params: {
    agent: Agent;
    db: HiBossDatabase;
    scope: SessionExecutionScope;
    envelopes: Envelope[];
    trigger?: AgentRunTrigger;
    refreshReasons: string[];
  }): void {
    const existingTail = this.sessionLocks.get(params.scope.cacheKey);
    const previous = (existingTail ?? Promise.resolve()).catch(() => undefined);
    const expectedAbortGeneration = this.getAbortGeneration(params.agent.name);
    this.incrementAgentTaskCount(params.agent.name);

    const current = previous
      .then(async () => {
        if (!this.isAbortGenerationCurrent(params.agent.name, expectedAbortGeneration)) {
          return;
        }
        const releaseGlobal = await this.globalRunSemaphore.acquire();
        const releaseAgent = await this.getAgentSemaphore(params.agent.name).acquire();
        try {
          if (!this.isAbortGenerationCurrent(params.agent.name, expectedAbortGeneration)) {
            return;
          }
          await this.runSessionExecution({
            ...params,
            abortGeneration: expectedAbortGeneration,
          });
        } finally {
          releaseAgent();
          releaseGlobal();
        }
      })
      .finally(() => {
        if (this.sessionLocks.get(params.scope.cacheKey) === current) {
          this.sessionLocks.delete(params.scope.cacheKey);
        }
        this.decrementAgentTaskCount(params.agent.name);
      });

    this.sessionLocks.set(params.scope.cacheKey, current);
  }

  private async runSessionExecution(params: {
    agent: Agent;
    db: HiBossDatabase;
    scope: SessionExecutionScope;
    envelopes: Envelope[];
    trigger?: AgentRunTrigger;
    refreshReasons: string[];
    abortGeneration: number;
  }): Promise<void> {
    const envelopeIds = params.envelopes.map((e) => e.id);
    const pendingRemainingCount = countDuePendingEnvelopesForAgent(params.db, params.agent.name);
    const triggerFields = getTriggerFields(params.trigger);
    if (!this.isAbortGenerationCurrent(params.agent.name, params.abortGeneration)) {
      for (const env of params.envelopes) {
        params.db.recordEnvelopeStatusEvent({
          envelope: env,
          fromStatus: env.status,
          toStatus: env.status,
          reason: "executor-skip-aborted",
          outcome: "skipped-after-abort-generation",
          origin: "internal",
        });
      }
      logEvent("info", "agent-run-skip-aborted", {
        "agent-name": params.agent.name,
        "envelopes-read-count": envelopeIds.length,
        "session-scope": params.scope.kind,
        "session-key": params.scope.cacheKey,
      });
      return;
    }

    const run = params.db.createAgentRun(params.agent.name, envelopeIds);
    let runStartedAtMs: number | null = null;
    let runLifecycleStarted = false;
    let completionState: RunCompletionState | null = null;
    let completionError: string | undefined;
    let capturedTrace: CapturedRunTrace | null = null;
    let lastRunningTraceFingerprint = "";
    let lastRunningTraceWriteAtMs = 0;
    let runningTraceWriteFailed = false;

    const writeRunningTrace = (trace: { provider: "claude" | "codex"; entries: CapturedRunTrace["entries"] }): void => {
      if (!runStartedAtMs) return;
      const nowMs = Date.now();
      const last = trace.entries[trace.entries.length - 1];
      const fingerprint = [
        trace.provider,
        String(trace.entries.length),
        last?.type ?? "",
        last?.toolName ?? "",
        last?.text ?? "",
      ].join("|");
      if (
        fingerprint === lastRunningTraceFingerprint &&
        nowMs - lastRunningTraceWriteAtMs < 2_000
      ) {
        return;
      }

      lastRunningTraceFingerprint = fingerprint;
      lastRunningTraceWriteAtMs = nowMs;

      try {
        writeAgentRunTrace(this.hibossDir, {
          version: INTERNAL_VERSION,
          runId: run.id,
          agentName: params.agent.name,
          provider: trace.provider,
          status: "running",
          startedAt: runStartedAtMs,
          completedAt: nowMs,
          entries: trace.entries,
        });
      } catch (err) {
        if (!runningTraceWriteFailed) {
          runningTraceWriteFailed = true;
          logEvent("warn", "agent-run-trace-running-write-failed", {
            "agent-name": params.agent.name,
            "agent-run-id": run.id,
            error: errorMessage(err),
          });
        }
      }
    };

    const inFlight: InFlightAgentRun = {
      runRecordId: run.id,
      abortController: new AbortController(),
      childProcess: null,
    };
    const inFlightSet = this.inFlightRuns.get(params.agent.name) ?? new Set<InFlightAgentRun>();
    inFlightSet.add(inFlight);
    this.inFlightRuns.set(params.agent.name, inFlightSet);

    try {
      if (inFlight.abortController.signal.aborted) {
        const reason = inFlight.abortReason ?? "abort-requested";
        params.db.cancelAgentRun(run.id, reason);
        logEvent("info", "agent-run-complete", {
          "agent-name": params.agent.name,
          "agent-run-id": run.id,
          state: "cancelled",
          "duration-ms": 0,
          "context-length": null,
          reason,
        });
        return;
      }

      const session = await this.getOrCreateScopedSession(params.agent, params.db, params.scope, params.trigger);

      const turnInput = buildTurnInput({
        context: {
          datetimeMs: Date.now(),
          agentName: params.agent.name,
          bossTimezone: params.db.getBossTimezone(),
        },
        envelopes: params.envelopes,
      });

      logEvent("info", "agent-run-start", {
        "agent-name": params.agent.name,
        "agent-run-id": run.id,
        "envelopes-read-count": envelopeIds.length,
        "pending-remaining-count": pendingRemainingCount,
        ...triggerFields,
        "session-scope": params.scope.kind,
        "session-key": params.scope.cacheKey,
        "refresh-reasons": params.refreshReasons.length > 0 ? params.refreshReasons.join(",") : undefined,
      });
      runStartedAtMs = Date.now();
      runLifecycleStarted = true;

      if (this.onRunStarted) {
        try {
          await this.onRunStarted({
            agentName: params.agent.name,
            runId: run.id,
            envelopes: params.envelopes,
            db: params.db,
          });
        } catch (err) {
          logEvent("warn", "agent-run-start-hook-failed", {
            "agent-name": params.agent.name,
            "agent-run-id": run.id,
            error: errorMessage(err),
          });
        }
      }

      const turn = await executeCliTurn(session, turnInput, {
        hibossDir: this.hibossDir,
        agentName: params.agent.name,
        signal: inFlight.abortController.signal,
        onChildProcess: (proc) => {
          inFlight.childProcess = proc;
        },
        onTraceProgress: (trace) => {
          writeRunningTrace(trace);
        },
        onTraceCaptured: (trace) => {
          capturedTrace = trace;
        },
      });

      if (turn.status === "cancelled") {
        const reason = inFlight.abortReason ?? "run-cancelled";
        params.db.cancelAgentRun(run.id, reason);
        logEvent("info", "agent-run-complete", {
          "agent-name": params.agent.name,
          "agent-run-id": run.id,
          state: "cancelled",
          "duration-ms": runStartedAtMs ? Date.now() - runStartedAtMs : 0,
          "context-length": null,
          reason,
        });
        completionState = "cancelled";
        completionError = reason;
        return;
      }

      const response = turn.finalText;
      session.lastRunCompletedAtMs = Date.now();

      if (turn.sessionId) {
        session.sessionId = turn.sessionId;
      }

      if (params.scope.kind === "default") {
        if (session.sessionId) {
          try {
            writePersistedAgentSession(params.db, params.agent.name, {
              version: INTERNAL_VERSION,
              provider: session.provider,
              handle: {
                provider: session.provider,
                sessionId: session.sessionId,
                ...(session.provider === "codex" && session.codexCumulativeUsageTotals
                  ? { metadata: { codexCumulativeUsage: session.codexCumulativeUsageTotals } }
                  : {}),
              },
              createdAtMs: session.createdAtMs,
              lastRunCompletedAtMs: session.lastRunCompletedAtMs,
              updatedAtMs: Date.now(),
            });
          } catch (err) {
            logEvent("warn", "agent-session-snapshot-failed", {
              "agent-name": params.agent.name,
              error: errorMessage(err),
            });
          }
        }
      } else if (params.scope.kind === "channel") {
        try {
          params.db.updateAgentSessionProviderSessionId(
            params.scope.agentSessionId,
            session.sessionId ?? null,
            { provider: session.provider }
          );
          params.db.touchAgentSession(params.scope.agentSessionId, {
            lastActiveAt: Date.now(),
            adapterType: params.scope.adapterType,
            chatId: params.scope.chatId,
          });
        } catch (err) {
          logEvent("warn", "agent-session-channel-persist-failed", {
            "agent-name": params.agent.name,
            "agent-session-id": params.scope.agentSessionId,
            provider: session.provider,
            error: errorMessage(err),
          });
        }
      } else {
        try {
          params.db.updateAgentSessionProviderSessionId(
            params.scope.agentSessionId,
            session.sessionId ?? null,
            { provider: session.provider }
          );
          params.db.touchAgentSession(params.scope.agentSessionId, {
            lastActiveAt: Date.now(),
          });
        } catch (err) {
          logEvent("warn", "agent-session-pinned-persist-failed", {
            "agent-name": params.agent.name,
            "agent-session-id": params.scope.agentSessionId,
            provider: session.provider,
            error: errorMessage(err),
          });
        }
      }

      params.db.completeAgentRun(run.id, response, turn.usage.contextLength);

      logEvent("info", "agent-run-complete", {
        "agent-name": params.agent.name,
        "agent-run-id": run.id,
        state: "success",
        "duration-ms": runStartedAtMs ? Date.now() - runStartedAtMs : 0,
        "context-length": turn.usage.contextLength,
        "input-tokens": turn.usage.inputTokens,
        "output-tokens": turn.usage.outputTokens,
        "cache-read-tokens": turn.usage.cacheReadTokens,
        "cache-write-tokens": turn.usage.cacheWriteTokens,
        "total-tokens": turn.usage.totalTokens,
      });

      const policy = this.getSessionPolicy(params.agent);
      if (
        typeof policy.maxContextLength === "number" &&
        turn.usage.contextLength !== null &&
        turn.usage.contextLength > policy.maxContextLength
      ) {
        if (params.scope.kind === "default") {
          await this.refreshSession(
            params.agent.name,
            `max-context-length:${turn.usage.contextLength}>${policy.maxContextLength}`
          );
        } else {
          this.channelSessions.delete(params.scope.cacheKey);
          params.db.updateAgentSessionProviderSessionId(params.scope.agentSessionId, null, {
            provider: session.provider,
          });
        }
      }
      completionState = "success";
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      params.db.failAgentRun(run.id, errMsg);
      logEvent("info", "agent-run-complete", {
        "agent-name": params.agent.name,
        "agent-run-id": run.id,
        state: "failed",
        "duration-ms": runStartedAtMs ? Date.now() - runStartedAtMs : 0,
        "context-length": null,
        error: errMsg,
      });
      completionState = "failed";
      completionError = errMsg;
    } finally {
      const set = this.inFlightRuns.get(params.agent.name);
      if (set) {
        set.delete(inFlight);
        if (set.size === 0) {
          this.inFlightRuns.delete(params.agent.name);
        }
      }

      if (runLifecycleStarted && completionState && this.onRunFinished) {
        try {
          await this.onRunFinished({
            agentName: params.agent.name,
            runId: run.id,
            envelopes: params.envelopes,
            db: params.db,
            state: completionState,
            ...(completionError ? { error: completionError } : {}),
          });
        } catch (err) {
          logEvent("warn", "agent-run-finish-hook-failed", {
            "agent-name": params.agent.name,
            "agent-run-id": run.id,
            error: errorMessage(err),
          });
        }
      }

      const traceToWrite = capturedTrace;
      if (runLifecycleStarted && completionState && runStartedAtMs && traceToWrite !== null) {
        const traceRecord = traceToWrite as CapturedRunTrace;
        try {
          writeAgentRunTrace(this.hibossDir, {
            version: INTERNAL_VERSION,
            runId: run.id,
            agentName: params.agent.name,
            provider: traceRecord.provider,
            status: traceRecord.status,
            startedAt: runStartedAtMs,
            completedAt: Date.now(),
            ...(completionError ? { error: completionError } : {}),
            entries: traceRecord.entries,
          });
        } catch (err) {
          logEvent("warn", "agent-run-trace-write-failed", {
            "agent-name": params.agent.name,
            "agent-run-id": run.id,
            error: errorMessage(err),
          });
        }
      }
    }
  }

  private async getOrCreateScopedSession(
    agent: Agent,
    db: HiBossDatabase,
    scope: SessionExecutionScope,
    trigger?: AgentRunTrigger
  ): Promise<AgentSession> {
    if (scope.kind === "default") {
      return this.getOrCreateDefaultSession(agent, db, trigger);
    }
    if (scope.kind === "channel") {
      return this.getOrCreateChannelSession(agent, db, scope);
    }
    return this.getOrCreatePinnedSession(agent, db, scope);
  }

  private async getOrCreateDefaultSession(
    agent: Agent,
    db: HiBossDatabase,
    trigger?: AgentRunTrigger
  ): Promise<AgentSession> {
    const session = await getOrCreateAgentSession({
      agent,
      db,
      hibossDir: this.hibossDir,
      sessions: this.sessions,
      applyPendingSessionRefresh: async () => [],
      refreshSession: (name, reason) => this.refreshSession(name, reason),
      getSessionPolicy: (a) => this.getSessionPolicy(a),
      trigger,
    });
    this.conversationHistory?.ensureActiveSession(agent.name);
    return session;
  }

  private async getOrCreateChannelSession(
    agent: Agent,
    db: HiBossDatabase,
    scope: Extract<SessionExecutionScope, { kind: "channel" }>
  ): Promise<AgentSession> {
    const cached = this.channelSessions.get(scope.cacheKey);
    const policy = this.getSessionPolicy(agent);
    if (cached) {
      const reason = getRefreshReasonForPolicy(cached, policy, new Date());
      if (!reason) return cached;
      this.channelSessions.delete(scope.cacheKey);
      db.updateAgentSessionProviderSessionId(scope.agentSessionId, null, {
        provider: cached.provider,
      });
    }

    const persistedRow = db.getAgentSessionById(scope.agentSessionId);
    const provider = persistedRow?.provider ?? (agent.provider ?? DEFAULT_AGENT_PROVIDER);
    const providerEnvOverrides = getProviderCliEnvOverrides(agent.metadata, provider);

    const baseSession = await this.getOrCreateDefaultSession(agent, db);
    const session: AgentSession = {
      provider,
      agentToken: baseSession.agentToken,
      systemInstructions: baseSession.systemInstructions,
      workspace: baseSession.workspace,
      providerEnvOverrides,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      sessionId: persistedRow?.providerSessionId ?? undefined,
      createdAtMs: persistedRow?.createdAt ?? Date.now(),
      ...(persistedRow ? { lastRunCompletedAtMs: persistedRow.lastActiveAt } : {}),
    };
    this.channelSessions.set(scope.cacheKey, session);
    this.conversationHistory?.ensureActiveSession(agent.name);
    return session;
  }

  private async getOrCreatePinnedSession(
    agent: Agent,
    db: HiBossDatabase,
    scope: Extract<SessionExecutionScope, { kind: "pinned" }>
  ): Promise<AgentSession> {
    const cached = this.channelSessions.get(scope.cacheKey);
    const policy = this.getSessionPolicy(agent);
    if (cached) {
      const reason = getRefreshReasonForPolicy(cached, policy, new Date());
      if (!reason) return cached;
      this.channelSessions.delete(scope.cacheKey);
      db.updateAgentSessionProviderSessionId(scope.agentSessionId, null, {
        provider: cached.provider,
      });
    }

    const persistedRow = db.getAgentSessionById(scope.agentSessionId);
    const provider = persistedRow?.provider ?? (agent.provider ?? DEFAULT_AGENT_PROVIDER);
    const providerEnvOverrides = getProviderCliEnvOverrides(agent.metadata, provider);

    const baseSession = await this.getOrCreateDefaultSession(agent, db);
    const session: AgentSession = {
      provider,
      agentToken: baseSession.agentToken,
      systemInstructions: baseSession.systemInstructions,
      workspace: baseSession.workspace,
      providerEnvOverrides,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      sessionId: persistedRow?.providerSessionId ?? undefined,
      createdAtMs: persistedRow?.createdAt ?? Date.now(),
      ...(persistedRow ? { lastRunCompletedAtMs: persistedRow.lastActiveAt } : {}),
    };
    this.channelSessions.set(scope.cacheKey, session);
    this.conversationHistory?.ensureActiveSession(agent.name);
    return session;
  }

  /**
   * Refresh session for an agent (called by /new command).
   *
   * Clears the existing session so a new one will be created on next run.
   */
  async refreshSession(agentName: string, reason?: string): Promise<void> {
    this.pendingSessionRefresh.delete(agentName);
    this.pendingSessionContextReload.delete(agentName);

    if (this.conversationHistory) {
      // Recover old session so we can capture its file path.
      this.conversationHistory.recoverSession(agentName);
      const oldSessionFilePath = this.conversationHistory.getCurrentSessionFilePath(agentName);

      // Create new history session FIRST so incoming envelopes land in the new session
      // (avoids race where messages arriving during close flow go to the old session).
      this.conversationHistory.startSession(agentName);

      // Best-effort: close the old session file.
      if (oldSessionFilePath) {
        try {
          closeSessionByPath({
            filePath: oldSessionFilePath,
            agentName,
          });
        } catch (err) {
          logEvent("warn", "session-close-on-refresh-failed", {
            "agent-name": agentName,
            reason,
            error: errorMessage(err),
          });
        }
      }
    }

    if (this.db) {
      try {
        writePersistedAgentSession(this.db, agentName, null);
        this.db.clearAgentSessionProviderHandles(agentName);
      } catch (err) {
        logEvent("warn", "agent-session-handle-clear-failed", {
          "agent-name": agentName,
          reason,
          error: errorMessage(err),
        });
      }
    }

    this.sessions.delete(agentName);
    for (const key of [...this.channelSessions.keys()]) {
      if (
        key.startsWith(`channel-session:${agentName}:`) ||
        key.startsWith(`agent-session:${agentName}:`)
      ) {
        this.channelSessions.delete(key);
      }
    }

    logEvent("info", "agent-session-remove", {
      "agent-name": agentName,
      reason,
      state: "success",
    });
  }

  /**
   * Close all sessions on shutdown.
   */
  async closeAll(): Promise<void> {
    // Best-effort: close all active sessions before shutdown.
    if (this.conversationHistory) {
      try {
        const defaultSessionAgents = [...this.sessions.keys()];
        const channelSessionAgents = [...this.channelSessions.keys()]
          .map((key) => key.split(":")[1] ?? "")
          .filter((value) => value.length > 0);
        const historyAgents = this.conversationHistory.getActiveAgentNames();
        const agentNames = [...new Set([...defaultSessionAgents, ...channelSessionAgents, ...historyAgents])];
        closeAllActiveSessions({
          history: this.conversationHistory,
          agentNames,
        });
      } catch (err) {
        logEvent("warn", "session-close-on-close-all-failed", {
          error: errorMessage(err),
        });
      }
    }

    // Kill any in-flight CLI processes
    for (const [, set] of this.inFlightRuns) {
      for (const inFlight of set) {
        if (inFlight.childProcess) {
          try {
            inFlight.childProcess.kill("SIGTERM");
          } catch {
            // best-effort
          }
        }
      }
    }
    this.sessions.clear();
    this.channelSessions.clear();
    this.agentDispatchLocks.clear();
    this.sessionLocks.clear();
    this.agentQueuedTaskCount.clear();
    this.inFlightRuns.clear();
    this.abortGenerationByAgent.clear();
    this.pendingSessionRefresh.clear();
    this.pendingSessionContextReload.clear();
  }
}

export function createAgentExecutor(options?: {
  db?: HiBossDatabase;
  hibossDir?: string;
  conversationHistory?: ConversationHistory;
  onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;
  onRunStarted?: AgentRunStartedHook;
  onRunFinished?: AgentRunFinishedHook;
  sessionConcurrencyPerAgent?: number;
  sessionConcurrencyGlobal?: number;
}): AgentExecutor {
  return new AgentExecutor(options);
}
