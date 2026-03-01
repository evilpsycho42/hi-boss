import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { SCHEMA_SQL } from "./schema.js";
import type { Agent, AgentPermissionLevel, RegisterAgentInput } from "../../agent/types.js";
import type {
  Envelope,
  CreateEnvelopeInput,
  EnvelopeStatus,
  EnvelopeOrigin,
} from "../../envelope/types.js";
import type { CronSchedule, CreateCronScheduleInput } from "../../cron/types.js";
import type { SessionPolicyConfig } from "../../shared/session-policy.js";
import {
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_SESSION_CONCURRENCY_GLOBAL,
  DEFAULT_SESSION_CONCURRENCY_PER_AGENT,
  getDefaultAgentDescription,
} from "../../shared/defaults.js";
import { generateToken, hashToken, verifyToken } from "../../agent/auth.js";
import { generateUUID } from "../../shared/uuid.js";
import { assertValidAgentName, assertValidTeamName } from "../../shared/validation.js";
import { getDaemonIanaTimeZone } from "../../shared/timezone.js";
import type { Settings } from "../../shared/settings.js";
import type { Team, TeamMember, TeamKind, TeamStatus } from "../../team/types.js";

/**
 * Database row types for SQLite mapping.
 */
interface AgentRow {
  name: string;
  token: string;  // agent token (short identifier, e.g. "abc123")
  description: string | null;
  workspace: string | null;
  provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  permission_level: string | null;
  session_policy: string | null;
  created_at: number;
  last_seen_at: number | null;
  metadata: string | null;
}

interface EnvelopeRow {
  id: string;
  from: string;
  to: string;
  from_boss: number;
  content_text: string | null;
  content_attachments: string | null;
  priority: number | null;
  deliver_at: number | null;
  status: string;
  created_at: number;
  metadata: string | null;
}

interface CronScheduleRow {
  id: string;
  agent_name: string;
  cron: string;
  timezone: string | null;
  enabled: number;
  to_address: string;
  content_text: string | null;
  content_attachments: string | null;
  metadata: string | null;
  pending_envelope_id: string | null;
  created_at: number;
  updated_at: number | null;
  pending_deliver_at?: number | null;
  pending_status?: string | null;
}

interface AgentBindingRow {
  id: string;
  agent_name: string;
  adapter_type: string;
  adapter_token: string;
  created_at: number;
}

interface AgentRunRow {
  id: string;
  agent_name: string;
  started_at: number;
  completed_at: number | null;
  envelope_ids: string | null;
  final_response: string | null;
  context_length: number | null;
  status: string;
  error: string | null;
}

interface TeamRow {
  name: string;
  description: string | null;
  status: string;
  kind: string;
  created_at: number;
  metadata: string | null;
}

interface TeamMemberRow {
  team_name: string;
  agent_name: string;
  source: string;
  created_at: number;
}

interface AgentSessionRow {
  id: string;
  agent_name: string;
  provider: string;
  provider_session_id: string | null;
  created_at: number;
  last_active_at: number;
  last_adapter_type: string | null;
  last_chat_id: string | null;
}

interface ChannelSessionBindingRow {
  id: string;
  agent_name: string;
  adapter_type: string;
  chat_id: string;
  default_session_id: string;
  owner_user_id: string | null;
  updated_at: number;
}

interface SessionLinkWithSessionRow {
  id: string;
  agent_name: string;
  adapter_type: string;
  chat_id: string;
  session_id: string;
  owner_user_id: string | null;
  first_seen_at: number;
  last_seen_at: number;
  created_at: number;
  last_active_at: number;
  provider: string;
  provider_session_id: string | null;
  last_adapter_type: string | null;
  last_chat_id: string | null;
}

/**
 * Agent binding type.
 */
export interface AgentBinding {
  id: string;
  agentName: string;
  adapterType: string;
  adapterToken: string;
  createdAt: number;
}

/**
 * Agent run type for auditing.
 */
export interface AgentRun {
  id: string;
  agentName: string;
  startedAt: number;
  completedAt?: number;
  envelopeIds: string[];
  finalResponse?: string;
  contextLength?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  error?: string;
}

export interface AgentSessionRecord {
  id: string;
  agentName: string;
  provider: "claude" | "codex";
  providerSessionId?: string;
  createdAt: number;
  lastActiveAt: number;
  lastAdapterType?: string;
  lastChatId?: string;
}

export interface ChannelSessionBinding {
  id: string;
  agentName: string;
  adapterType: string;
  chatId: string;
  defaultSessionId: string;
  ownerUserId?: string;
  updatedAt: number;
}

export type SessionListScope = "current-chat" | "my-chats" | "agent-all";

export interface SessionListItem {
  session: AgentSessionRecord;
  link: {
    adapterType: string;
    chatId: string;
    ownerUserId?: string;
    firstSeenAt: number;
    lastSeenAt: number;
  };
}

export interface EnvelopeCreatedEvent {
  envelope: Envelope;
  origin: EnvelopeOrigin;
  timestampMs: number;
}

export interface EnvelopeStatusChangedEvent {
  envelope: Envelope;
  envelopeId: string;
  fromStatus: EnvelopeStatus;
  toStatus: EnvelopeStatus;
  reason?: string;
  outcome?: string;
  origin: EnvelopeOrigin;
  timestampMs: number;
}

export interface EnvelopeLifecycleHooks {
  onEnvelopeCreated?: (event: EnvelopeCreatedEvent) => void;
  onEnvelopeStatusChanged?: (event: EnvelopeStatusChangedEvent) => void;
}

/**
 * SQLite database wrapper for Hi-Boss.
 */
export class HiBossDatabase {
  private db: Database.Database;
  private envelopeLifecycleHooks: EnvelopeLifecycleHooks = {};

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  setEnvelopeLifecycleHooks(hooks: EnvelopeLifecycleHooks): void {
    this.envelopeLifecycleHooks = hooks;
  }

  private initSchema(): void {
    this.db.exec(SCHEMA_SQL);
    this.ensureEnvelopePriorityColumn();
    this.assertSchemaCompatible();
    this.reconcileStaleAgentRunsOnStartup();
  }

  private ensureEnvelopePriorityColumn(): void {
    const info = this.db.prepare("PRAGMA table_info(envelopes)").all() as Array<{ name: string }>;
    if (info.some((col) => col.name === "priority")) return;
    this.db.prepare("ALTER TABLE envelopes ADD COLUMN priority INTEGER DEFAULT 0").run();
  }

  private assertSchemaCompatible(): void {
    const requiredColumnsByTable: Record<string, string[]> = {
      config: ["key", "value", "created_at"],
      agents: [
        "name",
        "token",
        "description",
        "workspace",
        "provider",
        "model",
        "reasoning_effort",
        "permission_level",
        "session_policy",
        "created_at",
        "last_seen_at",
        "metadata",
      ],
      teams: [
        "name",
        "description",
        "status",
        "kind",
        "created_at",
        "metadata",
      ],
      team_members: [
        "team_name",
        "agent_name",
        "source",
        "created_at",
      ],
      envelopes: [
        "id",
        "from",
        "to",
        "from_boss",
        "content_text",
        "content_attachments",
        "priority",
        "deliver_at",
        "status",
        "created_at",
        "metadata",
      ],
      cron_schedules: [
        "id",
        "agent_name",
        "cron",
        "timezone",
        "enabled",
        "to_address",
        "content_text",
        "content_attachments",
        "metadata",
        "pending_envelope_id",
        "created_at",
        "updated_at",
      ],
      agent_bindings: ["id", "agent_name", "adapter_type", "adapter_token", "created_at"],
      agent_runs: [
        "id",
        "agent_name",
        "started_at",
        "completed_at",
        "envelope_ids",
        "final_response",
        "context_length",
        "status",
        "error",
      ],
      agent_sessions: [
        "id",
        "agent_name",
        "provider",
        "provider_session_id",
        "created_at",
        "last_active_at",
        "last_adapter_type",
        "last_chat_id",
      ],
      channel_session_bindings: [
        "id",
        "agent_name",
        "adapter_type",
        "chat_id",
        "default_session_id",
        "owner_user_id",
        "updated_at",
      ],
      channel_session_links: [
        "id",
        "agent_name",
        "adapter_type",
        "chat_id",
        "session_id",
        "owner_user_id",
        "first_seen_at",
        "last_seen_at",
      ],
    };

    const expectedIntegerColumns: Array<{ table: string; column: string }> = [
      { table: "config", column: "created_at" },
      { table: "agents", column: "created_at" },
      { table: "agents", column: "last_seen_at" },
      { table: "teams", column: "created_at" },
      { table: "team_members", column: "created_at" },
      { table: "agent_bindings", column: "created_at" },
      { table: "envelopes", column: "created_at" },
      { table: "envelopes", column: "priority" },
      { table: "envelopes", column: "deliver_at" },
      { table: "cron_schedules", column: "created_at" },
      { table: "cron_schedules", column: "updated_at" },
      { table: "agent_runs", column: "started_at" },
      { table: "agent_runs", column: "completed_at" },
      { table: "agent_sessions", column: "created_at" },
      { table: "agent_sessions", column: "last_active_at" },
      { table: "channel_session_bindings", column: "updated_at" },
      { table: "channel_session_links", column: "first_seen_at" },
      { table: "channel_session_links", column: "last_seen_at" },
    ];

    for (const [table, requiredColumns] of Object.entries(requiredColumnsByTable)) {
      const info = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
      }>;
      if (info.length === 0) {
        throw new Error(
          `Unsupported database schema: missing table ${table}. ` +
            `Reset your local state by deleting your Hi-Boss directory (default ~/hiboss; override via $HIBOSS_DIR).`
        );
      }
      const names = new Set(info.map((c) => c.name));
      for (const col of requiredColumns) {
        if (!names.has(col)) {
          throw new Error(
            `Unsupported database schema: missing ${table}.${col}. ` +
              `Reset your local state by deleting your Hi-Boss directory (default ~/hiboss; override via $HIBOSS_DIR).`
          );
        }
      }
    }

    for (const spec of expectedIntegerColumns) {
      const info = this.db.prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{
        name: string;
        type: string;
      }>;
      const col = info.find((c) => c.name === spec.column);
      if (!col) continue;

      const type = String(col.type ?? "").trim().toUpperCase();
      const isInteger = type === "INTEGER" || type === "INT" || type.startsWith("INT(");
      if (!isInteger) {
        throw new Error(
          `Unsupported database schema: expected ${spec.table}.${spec.column} to be INTEGER (unix-ms), got '${col.type}'. ` +
            `Reset your local state by deleting your Hi-Boss directory (default ~/hiboss; override via $HIBOSS_DIR).`
        );
      }
    }
  }

  private reconcileStaleAgentRunsOnStartup(): void {
    const info = this.db.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>;
    if (info.length === 0) return;

    // Best-effort: mark any "running" runs as failed on startup. Runs cannot survive daemon restarts.
    const nowMs = Date.now();
    this.db.prepare(`
      UPDATE agent_runs
      SET status = 'failed',
          completed_at = CASE WHEN completed_at IS NULL THEN ? ELSE completed_at END,
          error = CASE WHEN error IS NULL OR error = '' THEN 'daemon-stopped' ELSE error END
      WHERE status = 'running'
    `).run(nowMs);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Run a set of operations inside a single SQLite transaction.
   * Rolls back automatically if the callback throws.
   */
  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Clear setup-managed rows so a declarative setup import can recreate them.
   *
   * Notes:
   * - Keeps envelopes (including envelope history) and config keys intact.
   * - Clears agent run audit in `agent_runs`.
   * - Clears cron schedules to avoid orphan schedules that reference removed agents.
   */
  clearSetupManagedState(): void {
    this.db.prepare("DELETE FROM cron_schedules").run();
    this.db.prepare("DELETE FROM channel_session_links").run();
    this.db.prepare("DELETE FROM channel_session_bindings").run();
    this.db.prepare("DELETE FROM agent_sessions").run();
    this.db.prepare("DELETE FROM team_members").run();
    this.db.prepare("DELETE FROM teams").run();
    this.db.prepare("DELETE FROM agent_bindings").run();
    this.db.prepare("DELETE FROM agent_runs").run();
    this.db.prepare("DELETE FROM agents").run();
  }

  /**
   * Apply settings snapshot into runtime cache tables.
   * Keeps envelopes and agent run history intact.
   */
  applySettingsSnapshot(settings: Settings): void {
    this.runInTransaction(() => {
      this.setBossName(settings.boss.name);
      this.setConfig("boss_timezone", settings.boss.timezone);
      if (!this.verifyAdminToken(settings.admin.token)) {
        this.setAdminToken(settings.admin.token);
      }
      this.setConfig("permission_policy", JSON.stringify(settings.permissionPolicy));
      this.setConfig(
        "user_permission_policy",
        settings.userPermissionPolicy ? JSON.stringify(settings.userPermissionPolicy) : ""
      );
      this.setAdapterBossIds("telegram", settings.telegram.bossIds);
      this.setRuntimeSessionConcurrency({
        perAgent: settings.runtime?.sessionConcurrency?.perAgent ?? DEFAULT_SESSION_CONCURRENCY_PER_AGENT,
        global: settings.runtime?.sessionConcurrency?.global ?? DEFAULT_SESSION_CONCURRENCY_GLOBAL,
      });

      const existingAgents = this.listAgents();
      const existingByName = new Map(existingAgents.map((agent) => [agent.name.toLowerCase(), agent]));
      const desiredByName = new Map(settings.agents.map((agent) => [agent.name.toLowerCase(), agent]));

      for (const existing of existingAgents) {
        if (desiredByName.has(existing.name.toLowerCase())) continue;
        this.db.prepare("DELETE FROM channel_session_links WHERE agent_name = ?").run(existing.name);
        this.db.prepare("DELETE FROM channel_session_bindings WHERE agent_name = ?").run(existing.name);
        this.db.prepare("DELETE FROM agent_sessions WHERE agent_name = ?").run(existing.name);
        this.db.prepare("DELETE FROM cron_schedules WHERE agent_name = ?").run(existing.name);
        this.db.prepare("DELETE FROM agent_bindings WHERE agent_name = ?").run(existing.name);
        this.db.prepare("DELETE FROM agents WHERE name = ?").run(existing.name);
      }

      const upsertAgentStmt = this.db.prepare(`
        INSERT INTO agents
          (name, token, description, workspace, provider, model, reasoning_effort, permission_level, session_policy, created_at, metadata)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          token = excluded.token,
          description = excluded.description,
          workspace = excluded.workspace,
          provider = excluded.provider,
          model = excluded.model,
          reasoning_effort = excluded.reasoning_effort,
          permission_level = excluded.permission_level,
          session_policy = excluded.session_policy,
          metadata = excluded.metadata
      `);

      const now = Date.now();
      for (const agent of settings.agents) {
        const existing = existingByName.get(agent.name.toLowerCase());
        const existingSessionHandle =
          existing &&
          existing.metadata &&
          typeof existing.metadata.sessionHandle === "string" &&
          existing.metadata.sessionHandle.trim().length > 0
            ? existing.metadata.sessionHandle
            : undefined;

        const metadataInput: Record<string, unknown> = {
          ...(agent.metadata ?? {}),
        };
        if (existingSessionHandle && metadataInput.sessionHandle === undefined) {
          metadataInput.sessionHandle = existingSessionHandle;
        }

        const metadata = Object.keys(metadataInput).length > 0 ? metadataInput : undefined;

        upsertAgentStmt.run(
          agent.name,
          agent.token,
          agent.description,
          agent.workspace,
          agent.provider,
          agent.model ?? null,
          agent.reasoningEffort ?? null,
          agent.permissionLevel,
          agent.sessionPolicy ? JSON.stringify(agent.sessionPolicy) : null,
          now,
          metadata ? JSON.stringify(metadata) : null
        );

        const currentBindings = this.getBindingsByAgentName(agent.name);
        const currentByType = new Map(currentBindings.map((binding) => [binding.adapterType, binding]));
        const desiredByType = new Map(agent.bindings.map((binding) => [binding.adapterType, binding]));
        const bindingsUnchanged =
          currentByType.size === desiredByType.size &&
          Array.from(desiredByType.entries()).every(
            ([adapterType, binding]) => currentByType.get(adapterType)?.adapterToken === binding.adapterToken
          );

        if (!bindingsUnchanged) {
          for (const [adapterType] of currentByType) {
            if (desiredByType.has(adapterType)) continue;
            this.db.prepare("DELETE FROM agent_bindings WHERE agent_name = ? AND adapter_type = ?").run(
              agent.name,
              adapterType
            );
          }

          for (const desiredBinding of agent.bindings) {
            const currentBinding = currentByType.get(desiredBinding.adapterType);
            if (!currentBinding) {
              this.db.prepare(`
                INSERT INTO agent_bindings (id, agent_name, adapter_type, adapter_token, created_at)
                VALUES (?, ?, ?, ?, ?)
              `).run(generateUUID(), agent.name, desiredBinding.adapterType, desiredBinding.adapterToken, now);
              continue;
            }
            if (currentBinding.adapterToken !== desiredBinding.adapterToken) {
              this.db.prepare(
                "UPDATE agent_bindings SET adapter_token = ? WHERE agent_name = ? AND adapter_type = ?"
              ).run(desiredBinding.adapterToken, agent.name, desiredBinding.adapterType);
            }
          }
        }
      }

      this.markSetupComplete();
    });
  }

  // ==================== Agent Operations ====================

  /**
   * Register a new agent and return the token.
   */
  registerAgent(input: RegisterAgentInput): { agent: Agent; token: string } {
    assertValidAgentName(input.name);

    const existing = this.getAgentByNameCaseInsensitive(input.name);
    if (existing) {
      throw new Error("Agent already exists");
    }

    const token = generateToken();
    const createdAt = Date.now();
    const metadataWithSessionTrimmed = (() => {
      const base = input.metadata ? { ...input.metadata } : {};
      delete (base as Record<string, unknown>).sessionHandle;
      return Object.keys(base).length > 0 ? base : undefined;
    })();

    const stmt = this.db.prepare(`
      INSERT INTO agents (name, token, description, workspace, provider, model, reasoning_effort, permission_level, session_policy, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      input.name,
      token,  // store raw token directly
      input.description ?? getDefaultAgentDescription(input.name),
      input.workspace ?? null,
      input.provider ?? DEFAULT_AGENT_PROVIDER,
      input.model ?? null,
      input.reasoningEffort ?? null,
      input.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL,
      input.sessionPolicy ? JSON.stringify(input.sessionPolicy) : null,
      createdAt,
      metadataWithSessionTrimmed ? JSON.stringify(metadataWithSessionTrimmed) : null
    );

    const agent = this.getAgentByName(input.name)!;
    return { agent, token };
  }

  /**
   * Get an agent by name.
   */
  getAgentByName(name: string): Agent | null {
    const stmt = this.db.prepare("SELECT * FROM agents WHERE name = ?");
    const row = stmt.get(name) as AgentRow | undefined;
    return row ? this.rowToAgent(row) : null;
  }

  /**
   * Get an agent by name (case-insensitive).
   *
   * Useful on case-insensitive filesystems to prevent routing / directory collisions.
   */
  getAgentByNameCaseInsensitive(name: string): Agent | null {
    const stmt = this.db.prepare("SELECT * FROM agents WHERE name = ? COLLATE NOCASE");
    const row = stmt.get(name) as AgentRow | undefined;
    return row ? this.rowToAgent(row) : null;
  }

  /**
   * Find an agent by token (direct comparison).
   */
  findAgentByToken(token: string): Agent | null {
    const stmt = this.db.prepare("SELECT * FROM agents WHERE token = ?");
    const row = stmt.get(token) as AgentRow | undefined;
    return row ? this.rowToAgent(row) : null;
  }

  /**
   * List all agents.
   */
  listAgents(): Agent[] {
    const stmt = this.db.prepare("SELECT * FROM agents ORDER BY created_at DESC");
    const rows = stmt.all() as AgentRow[];
    return rows.map((row) => this.rowToAgent(row));
  }

  /**
   * Update agent's last seen timestamp.
   */
  updateAgentLastSeen(name: string): void {
    const stmt = this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE name = ?");
    stmt.run(Date.now(), name);
  }

  /**
   * Update agent core fields stored in their respective columns.
   *
   * Notes:
   * - Uses the canonical agent name (case-insensitive lookup).
   * - Only fields present in `update` are modified.
   */
  updateAgentFields(
    name: string,
    update: {
      description?: string | null;
      workspace?: string | null;
      provider?: "claude" | "codex" | null;
      model?: string | null;
      reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | null;
    }
  ): Agent {
    const agent = this.getAgentByNameCaseInsensitive(name);
    if (!agent) {
      throw new Error("Agent not found");
    }

    const updates: string[] = [];
    const params: Array<string | null> = [];

    if (update.description !== undefined) {
      updates.push("description = ?");
      params.push(update.description);
    }
    if (update.workspace !== undefined) {
      updates.push("workspace = ?");
      params.push(update.workspace);
    }
    if (update.provider !== undefined) {
      updates.push("provider = ?");
      params.push(update.provider);
    }
    if (update.model !== undefined) {
      updates.push("model = ?");
      params.push(update.model);
    }
    if (update.reasoningEffort !== undefined) {
      updates.push("reasoning_effort = ?");
      params.push(update.reasoningEffort);
    }

    if (updates.length === 0) {
      return this.getAgentByName(agent.name)!;
    }

    if (updates.length > 0) {
      const stmt = this.db.prepare(`UPDATE agents SET ${updates.join(", ")} WHERE name = ?`);
      stmt.run(...params, agent.name);
    }

    return this.getAgentByName(agent.name)!;
  }

  /**
   * Update (or clear) the reserved `metadata.sessionHandle` field without rewriting the full metadata blob.
   *
   * This is used for best-effort session resume across daemon restarts.
   */
  setAgentMetadataSessionHandle(name: string, sessionHandle: unknown | null): void {
    if (sessionHandle === null) {
      // Preserve historical behavior: when metadata becomes empty, store NULL instead of "{}".
      const stmt = this.db.prepare(`
        UPDATE agents
        SET metadata = CASE
          WHEN metadata IS NULL THEN NULL
          WHEN json_remove(metadata, '$.sessionHandle') = '{}' THEN NULL
          ELSE json_remove(metadata, '$.sessionHandle')
        END
        WHERE name = ?
      `);
      stmt.run(name);
      return;
    }

    const stmt = this.db.prepare(`
      UPDATE agents
      SET metadata = json_set(COALESCE(metadata, '{}'), '$.sessionHandle', json(?))
      WHERE name = ?
    `);
    stmt.run(JSON.stringify(sessionHandle), name);
  }

  /**
   * Replace user-controlled agent metadata, preserving the reserved `metadata.sessionHandle` field when present.
   *
   * - When `metadata` is `null`, user metadata is cleared but `sessionHandle` is preserved if it exists.
   * - When no `sessionHandle` exists and `metadata` is `null`, the stored metadata becomes `NULL`.
   */
  replaceAgentMetadataPreservingSessionHandle(name: string, metadata: Record<string, unknown> | null): void {
    const agent = this.getAgentByNameCaseInsensitive(name);
    if (!agent) {
      throw new Error("Agent not found");
    }

    const withUserMetadata = (() => {
      const base = metadata ? { ...metadata } : {};
      delete (base as Record<string, unknown>).sessionHandle;
      return Object.keys(base).length > 0 ? base : undefined;
    })();

    const existingSessionHandle = (() => {
      const current = agent.metadata;
      if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
      return (current as Record<string, unknown>).sessionHandle;
    })();

    if (existingSessionHandle === undefined) {
      const stmt = this.db.prepare("UPDATE agents SET metadata = ? WHERE name = ?");
      stmt.run(withUserMetadata ? JSON.stringify(withUserMetadata) : null, agent.name);
      return;
    }

    const nextWithSessionHandle = {
      ...(withUserMetadata ?? {}),
      sessionHandle: existingSessionHandle,
    };
    const stmt = this.db.prepare("UPDATE agents SET metadata = ? WHERE name = ?");
    stmt.run(JSON.stringify(nextWithSessionHandle), agent.name);
  }

  /**
   * Set agent permission level stored in permission_level column.
   *
   * Notes:
   * - Uses the canonical agent name (case-insensitive lookup).
   */
  setAgentPermissionLevel(
    name: string,
    permissionLevel: AgentPermissionLevel
  ): { success: true; agentName: string; permissionLevel: string } {
    const agent = this.getAgentByNameCaseInsensitive(name);
    if (!agent) {
      throw new Error("Agent not found");
    }

    const stmt = this.db.prepare("UPDATE agents SET permission_level = ? WHERE name = ?");
    stmt.run(permissionLevel, agent.name);

    return { success: true, agentName: agent.name, permissionLevel };
  }

  /**
   * Update agent session policy stored in session_policy column.
   *
   * Notes:
   * - This is intentionally permissive; validation should happen in the daemon RPC layer.
   * - Unset fields are preserved unless `clear` is true.
   */
  updateAgentSessionPolicy(
    name: string,
    update: {
      clear?: boolean;
      dailyResetAt?: string;
      idleTimeout?: string;
      maxContextLength?: number;
    }
  ): Agent {
    const agent = this.getAgentByName(name);
    if (!agent) {
      throw new Error(`Agent ${name} not found in database`);
    }

    let nextPolicy: SessionPolicyConfig | null = null;

    if (update.clear) {
      nextPolicy = null;
    } else {
      const existingPolicy = agent.sessionPolicy ?? {};
      const merged: SessionPolicyConfig = { ...existingPolicy };

      if (typeof update.dailyResetAt === "string") {
        merged.dailyResetAt = update.dailyResetAt;
      }
      if (typeof update.idleTimeout === "string") {
        merged.idleTimeout = update.idleTimeout;
      }
      if (typeof update.maxContextLength === "number") {
        merged.maxContextLength = update.maxContextLength;
      }

      if (Object.keys(merged).length === 0) {
        nextPolicy = null;
      } else {
        nextPolicy = merged;
      }
    }

    const stmt = this.db.prepare("UPDATE agents SET session_policy = ? WHERE name = ?");
    stmt.run(nextPolicy ? JSON.stringify(nextPolicy) : null, name);

    return this.getAgentByName(name)!;
  }

  // ==================== Team Operations ====================

  createTeam(input: {
    name: string;
    description?: string;
    status?: TeamStatus;
    kind?: TeamKind;
    metadata?: Record<string, unknown>;
  }): Team {
    assertValidTeamName(input.name);
    const existing = this.getTeamByNameCaseInsensitive(input.name);
    if (existing) {
      throw new Error("Team already exists");
    }

    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO teams (name, description, status, kind, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      input.name,
      input.description?.trim() ? input.description.trim() : null,
      input.status ?? "active",
      input.kind ?? "manual",
      now,
      input.metadata ? JSON.stringify(input.metadata) : null
    );

    return this.getTeamByName(input.name)!;
  }

  getTeamByName(name: string): Team | null {
    const stmt = this.db.prepare("SELECT * FROM teams WHERE name = ?");
    const row = stmt.get(name) as TeamRow | undefined;
    return row ? this.rowToTeam(row) : null;
  }

  getTeamByNameCaseInsensitive(name: string): Team | null {
    const stmt = this.db.prepare("SELECT * FROM teams WHERE name = ? COLLATE NOCASE");
    const row = stmt.get(name) as TeamRow | undefined;
    return row ? this.rowToTeam(row) : null;
  }

  listTeams(options?: { status?: TeamStatus }): Team[] {
    const status = options?.status;
    if (status) {
      const stmt = this.db.prepare("SELECT * FROM teams WHERE status = ? ORDER BY created_at DESC");
      const rows = stmt.all(status) as TeamRow[];
      return rows.map((row) => this.rowToTeam(row));
    }

    const stmt = this.db.prepare("SELECT * FROM teams ORDER BY created_at DESC");
    const rows = stmt.all() as TeamRow[];
    return rows.map((row) => this.rowToTeam(row));
  }

  updateTeam(
    name: string,
    update: {
      description?: string | null;
      status?: TeamStatus;
      metadata?: Record<string, unknown> | null;
    }
  ): Team {
    const team = this.getTeamByNameCaseInsensitive(name);
    if (!team) {
      throw new Error("Team not found");
    }

    const updates: string[] = [];
    const params: Array<string | null> = [];

    if (update.description !== undefined) {
      updates.push("description = ?");
      params.push(update.description?.trim() ? update.description.trim() : null);
    }
    if (update.status !== undefined) {
      updates.push("status = ?");
      params.push(update.status);
    }
    if (update.metadata !== undefined) {
      updates.push("metadata = ?");
      params.push(update.metadata ? JSON.stringify(update.metadata) : null);
    }

    if (updates.length === 0) {
      return this.getTeamByName(team.name)!;
    }

    const stmt = this.db.prepare(`UPDATE teams SET ${updates.join(", ")} WHERE name = ?`);
    stmt.run(...params, team.name);
    return this.getTeamByName(team.name)!;
  }

  deleteTeam(name: string): boolean {
    const team = this.getTeamByNameCaseInsensitive(name);
    if (!team) return false;
    const stmt = this.db.prepare("DELETE FROM teams WHERE name = ?");
    const result = stmt.run(team.name);
    return result.changes > 0;
  }

  addTeamMember(input: {
    teamName: string;
    agentName: string;
    source?: TeamMember["source"];
  }): TeamMember {
    const team = this.getTeamByNameCaseInsensitive(input.teamName);
    if (!team) {
      throw new Error("Team not found");
    }
    const agent = this.getAgentByNameCaseInsensitive(input.agentName);
    if (!agent) {
      throw new Error("Agent not found");
    }

    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO team_members (team_name, agent_name, source, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(team.name, agent.name, input.source ?? "manual", now);

    const created = this.getTeamMember(team.name, agent.name);
    if (!created) {
      throw new Error("Failed to add team member");
    }
    return created;
  }

  removeTeamMember(input: { teamName: string; agentName: string }): boolean {
    const team = this.getTeamByNameCaseInsensitive(input.teamName);
    if (!team) return false;
    const agent = this.getAgentByNameCaseInsensitive(input.agentName);
    if (!agent) return false;

    const stmt = this.db.prepare(`
      DELETE FROM team_members
      WHERE team_name = ? AND agent_name = ?
    `);
    const result = stmt.run(team.name, agent.name);
    return result.changes > 0;
  }

  getTeamMember(teamName: string, agentName: string): TeamMember | null {
    const stmt = this.db.prepare(`
      SELECT * FROM team_members
      WHERE team_name = ? AND agent_name = ?
    `);
    const row = stmt.get(teamName, agentName) as TeamMemberRow | undefined;
    return row ? this.rowToTeamMember(row) : null;
  }

  listTeamMembers(teamName: string): TeamMember[] {
    const team = this.getTeamByNameCaseInsensitive(teamName);
    if (!team) return [];

    const stmt = this.db.prepare(`
      SELECT * FROM team_members
      WHERE team_name = ?
      ORDER BY created_at ASC, agent_name ASC
    `);
    const rows = stmt.all(team.name) as TeamMemberRow[];
    return rows.map((row) => this.rowToTeamMember(row));
  }

  listTeamMemberAgentNames(teamName: string): string[] {
    return this.listTeamMembers(teamName).map((item) => item.agentName);
  }

  listTeamsByAgentName(agentName: string, options?: { activeOnly?: boolean }): Team[] {
    const agent = this.getAgentByNameCaseInsensitive(agentName);
    if (!agent) return [];

    const activeOnly = options?.activeOnly !== false;
    if (activeOnly) {
      const stmt = this.db.prepare(`
        SELECT t.*
        FROM teams t
        INNER JOIN team_members tm ON tm.team_name = t.name
        WHERE tm.agent_name = ?
          AND t.status = 'active'
        ORDER BY tm.created_at ASC, t.created_at ASC, t.name ASC
      `);
      const rows = stmt.all(agent.name) as TeamRow[];
      return rows.map((row) => this.rowToTeam(row));
    }

    const stmt = this.db.prepare(`
      SELECT t.*
      FROM teams t
      INNER JOIN team_members tm ON tm.team_name = t.name
      WHERE tm.agent_name = ?
      ORDER BY tm.created_at ASC, t.created_at ASC, t.name ASC
    `);
    const rows = stmt.all(agent.name) as TeamRow[];
    return rows.map((row) => this.rowToTeam(row));
  }

  private rowToTeam(row: TeamRow): Team {
    let metadata: Record<string, unknown> | undefined;
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        metadata = undefined;
      }
    }

    const status: TeamStatus = row.status === "archived" ? "archived" : "active";
    const kind: TeamKind = row.kind === "manual" ? "manual" : "manual";

    return {
      name: row.name,
      description: row.description ?? undefined,
      status,
      kind,
      createdAt: row.created_at,
      metadata,
    };
  }

  private rowToTeamMember(row: TeamMemberRow): TeamMember {
    return {
      teamName: row.team_name,
      agentName: row.agent_name,
      source: row.source === "manual" ? "manual" : "manual",
      createdAt: row.created_at,
    };
  }

  private rowToAgent(row: AgentRow): Agent {
    // Parse permission level
    let permissionLevel: AgentPermissionLevel | undefined;
    if (
      row.permission_level === "restricted" ||
      row.permission_level === "standard" ||
      row.permission_level === "privileged" ||
      row.permission_level === "admin"
    ) {
      permissionLevel = row.permission_level;
    }

    // Parse session policy
    let sessionPolicy: SessionPolicyConfig | undefined;
    if (row.session_policy) {
      try {
        const raw = JSON.parse(row.session_policy) as unknown;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          sessionPolicy = raw as SessionPolicyConfig;
        }
      } catch {
        // ignore invalid JSON
      }
    }

    let metadata: Record<string, unknown> | undefined;
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        metadata = undefined;
      }
    }

    return {
      name: row.name,
      token: row.token,
      description: row.description ?? undefined,
      workspace: row.workspace ?? undefined,
      provider: (row.provider as 'claude' | 'codex') ?? undefined,
      model: row.model ?? undefined,
      reasoningEffort: (row.reasoning_effort as 'none' | 'low' | 'medium' | 'high' | 'xhigh') ?? undefined,
      permissionLevel,
      sessionPolicy,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at ?? undefined,
      metadata,
    };
  }

  // ==================== Envelope Operations ====================

  /**
   * Create a new envelope.
   */
  createEnvelope(input: CreateEnvelopeInput): Envelope {
    const id = generateUUID();
    const createdAt = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO envelopes (id, "from", "to", from_boss, content_text, content_attachments, priority, deliver_at, status, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.from,
      input.to,
      input.fromBoss ? 1 : 0,
      input.content.text ?? null,
      input.content.attachments ? JSON.stringify(input.content.attachments) : null,
      input.priority ?? 0,
      input.deliverAt ?? null,
      "pending",
      createdAt,
      input.metadata ? JSON.stringify(input.metadata) : null
    );

    const envelope = this.getEnvelopeById(id)!;
    this.emitEnvelopeCreated({
      envelope,
      origin: this.resolveEnvelopeOrigin(envelope.metadata, "internal"),
      timestampMs: createdAt,
    });
    return envelope;
  }

  /**
   * Get an envelope by ID.
   */
  getEnvelopeById(id: string): Envelope | null {
    const stmt = this.db.prepare("SELECT * FROM envelopes WHERE id = ?");
    const row = stmt.get(id) as EnvelopeRow | undefined;
    return row ? this.rowToEnvelope(row) : null;
  }

  /**
   * Find envelopes by compact UUID prefix (lowercase hex; hyphens ignored).
   *
   * Used for user/agent-facing short-id inputs (default 8 chars).
   */
  findEnvelopesByIdPrefix(idPrefix: string, limit = 50): Envelope[] {
    const prefix = idPrefix.trim().toLowerCase();
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 50;
    const stmt = this.db.prepare(`
      SELECT * FROM envelopes
      WHERE replace(lower(id), '-', '') LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(`${prefix}%`, n) as EnvelopeRow[];
    return rows.map((row) => this.rowToEnvelope(row));
  }

  /**
   * List envelopes for an address (inbox or outbox).
   */
  listEnvelopes(options: {
    address: string;
    box: "inbox" | "outbox";
    status?: EnvelopeStatus;
    limit?: number;
    dueOnly?: boolean;
  }): Envelope[] {
    const { address, box, status, limit, dueOnly } = options;
    const column = box === "inbox" ? '"to"' : '"from"';

    let sql = `SELECT * FROM envelopes WHERE ${column} = ?`;
    const params: (string | number)[] = [address];

    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }

    if (dueOnly) {
      const nowMs = Date.now();
      sql += " AND (deliver_at IS NULL OR deliver_at <= ?)";
      params.push(nowMs);
    }

    sql += " ORDER BY created_at DESC";

    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as EnvelopeRow[];
    return rows.map((row) => this.rowToEnvelope(row));
  }

  /**
   * List envelopes matching an exact from/to route.
   *
   * Used by `hiboss envelope list --to/--from` to fetch conversation slices
   * relevant to the authenticated agent.
   */
  listEnvelopesByRoute(options: {
    from: string;
    to: string;
    status: EnvelopeStatus;
    limit: number;
    dueOnly?: boolean;
    createdAfter?: number;
    createdBefore?: number;
  }): Envelope[] {
    const { from, to, status, limit, dueOnly, createdAfter, createdBefore } = options;

    let sql = `SELECT * FROM envelopes WHERE "from" = ? AND "to" = ? AND status = ?`;
    const params: (string | number)[] = [from, to, status];

    if (typeof createdAfter === "number") {
      sql += " AND created_at >= ?";
      params.push(createdAfter);
    }

    if (typeof createdBefore === "number") {
      sql += " AND created_at <= ?";
      params.push(createdBefore);
    }

    if (dueOnly) {
      const nowMs = Date.now();
      sql += " AND (deliver_at IS NULL OR deliver_at <= ?)";
      params.push(nowMs);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as EnvelopeRow[];
    return rows.map((row) => this.rowToEnvelope(row));
  }

  /**
   * Update envelope status.
   */
  updateEnvelopeStatus(
    id: string,
    status: EnvelopeStatus,
    options?: {
      reason?: string;
      outcome?: string;
      origin?: EnvelopeOrigin;
    }
  ): void {
    const before = this.getEnvelopeById(id);
    if (!before) return;
    if (before.status === status) return;

    const stmt = this.db.prepare("UPDATE envelopes SET status = ? WHERE id = ?");
    stmt.run(status, id);
    const after = this.getEnvelopeById(id);
    if (!after) return;

    this.emitEnvelopeStatusChanged({
      envelope: after,
      envelopeId: after.id,
      fromStatus: before.status,
      toStatus: after.status,
      reason: options?.reason,
      outcome: options?.outcome,
      origin: options?.origin ?? this.resolveEnvelopeOrigin(after.metadata, "internal"),
      timestampMs: Date.now(),
    });
  }

  /**
   * Update envelope metadata (JSON).
   */
  updateEnvelopeMetadata(id: string, metadata: Record<string, unknown> | undefined): void {
    const value = metadata ? JSON.stringify(metadata) : null;
    const stmt = this.db.prepare("UPDATE envelopes SET metadata = ? WHERE id = ?");
    stmt.run(value, id);
  }

  private rowToEnvelope(row: EnvelopeRow): Envelope {
    return {
      id: row.id,
      from: row.from,
      to: row.to,
      fromBoss: row.from_boss === 1,
      content: {
        text: row.content_text ?? undefined,
        attachments: row.content_attachments
          ? JSON.parse(row.content_attachments)
          : undefined,
      },
      priority: typeof row.priority === "number" ? row.priority : 0,
      deliverAt: row.deliver_at ?? undefined,
      status: row.status as EnvelopeStatus,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  recordEnvelopeStatusEvent(input: {
    envelope: Envelope;
    fromStatus: EnvelopeStatus;
    toStatus: EnvelopeStatus;
    reason?: string;
    outcome?: string;
    origin?: EnvelopeOrigin;
    timestampMs?: number;
  }): void {
    this.emitEnvelopeStatusChanged({
      envelope: input.envelope,
      envelopeId: input.envelope.id,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      reason: input.reason,
      outcome: input.outcome,
      origin: input.origin ?? this.resolveEnvelopeOrigin(input.envelope.metadata, "internal"),
      timestampMs: input.timestampMs ?? Date.now(),
    });
  }

  private emitEnvelopeCreated(event: EnvelopeCreatedEvent): void {
    try {
      this.envelopeLifecycleHooks.onEnvelopeCreated?.(event);
    } catch {
      // Non-blocking side-effect hook.
    }
  }

  private emitEnvelopeStatusChanged(event: EnvelopeStatusChangedEvent): void {
    try {
      this.envelopeLifecycleHooks.onEnvelopeStatusChanged?.(event);
    } catch {
      // Non-blocking side-effect hook.
    }
  }

  private resolveEnvelopeOrigin(
    metadata: Record<string, unknown> | undefined,
    fallback: EnvelopeOrigin,
  ): EnvelopeOrigin {
    const raw = metadata?.origin;
    if (
      raw === "cli" ||
      raw === "channel" ||
      raw === "cron" ||
      raw === "internal"
    ) {
      return raw;
    }
    return fallback;
  }

  // ==================== Cron Schedule Operations ====================

  /**
   * Create a new cron schedule.
   */
  createCronSchedule(input: CreateCronScheduleInput): CronSchedule {
    const id = generateUUID();
    const createdAt = Date.now();

    const enabled = input.enabled ?? true;
    const timezone =
      input.timezone && input.timezone.trim() && input.timezone.trim().toLowerCase() !== "local"
        ? input.timezone.trim()
        : null;

    const stmt = this.db.prepare(`
      INSERT INTO cron_schedules (id, agent_name, cron, timezone, enabled, to_address, content_text, content_attachments, metadata, pending_envelope_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.agentName,
      input.cron,
      timezone,
      enabled ? 1 : 0,
      input.to,
      input.content.text ?? null,
      input.content.attachments ? JSON.stringify(input.content.attachments) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      null,
      createdAt,
      null
    );

    return this.getCronScheduleById(id)!;
  }

  /**
   * Get a cron schedule by ID.
   */
  getCronScheduleById(id: string): CronSchedule | null {
    const stmt = this.db.prepare(`
      SELECT
        s.*,
        e.deliver_at AS pending_deliver_at,
        e.status AS pending_status
      FROM cron_schedules s
      LEFT JOIN envelopes e ON e.id = s.pending_envelope_id
      WHERE s.id = ?
    `);
    const row = stmt.get(id) as CronScheduleRow | undefined;
    return row ? this.rowToCronSchedule(row) : null;
  }

  /**
   * List cron schedules for an agent.
   */
  listCronSchedulesByAgent(agentName: string): CronSchedule[] {
    const stmt = this.db.prepare(`
      SELECT
        s.*,
        e.deliver_at AS pending_deliver_at,
        e.status AS pending_status
      FROM cron_schedules s
      LEFT JOIN envelopes e ON e.id = s.pending_envelope_id
      WHERE s.agent_name = ?
      ORDER BY s.created_at DESC
    `);
    const rows = stmt.all(agentName) as CronScheduleRow[];
    return rows.map((row) => this.rowToCronSchedule(row));
  }

  /**
   * Find cron schedules for an agent by compact UUID prefix (UUID with hyphens removed).
   */
  findCronSchedulesByAgentIdPrefix(agentName: string, compactIdPrefix: string): CronSchedule[] {
    const prefix = compactIdPrefix.trim().toLowerCase();
    if (!prefix) return [];

    const stmt = this.db.prepare(`
      SELECT
        s.*,
        e.deliver_at AS pending_deliver_at,
        e.status AS pending_status
      FROM cron_schedules s
      LEFT JOIN envelopes e ON e.id = s.pending_envelope_id
      WHERE s.agent_name = ?
        AND replace(lower(s.id), '-', '') LIKE ?
      ORDER BY s.created_at DESC
    `);
    const rows = stmt.all(agentName, `${prefix}%`) as CronScheduleRow[];
    return rows.map((row) => this.rowToCronSchedule(row));
  }

  /**
   * List all cron schedules (all agents).
   */
  listCronSchedules(): CronSchedule[] {
    const stmt = this.db.prepare(`
      SELECT
        s.*,
        e.deliver_at AS pending_deliver_at,
        e.status AS pending_status
      FROM cron_schedules s
      LEFT JOIN envelopes e ON e.id = s.pending_envelope_id
      ORDER BY s.created_at DESC
    `);
    const rows = stmt.all() as CronScheduleRow[];
    return rows.map((row) => this.rowToCronSchedule(row));
  }

  /**
   * Update cron schedule enabled flag.
   */
  updateCronScheduleEnabled(id: string, enabled: boolean): void {
    const updatedAt = Date.now();
    const stmt = this.db.prepare("UPDATE cron_schedules SET enabled = ?, updated_at = ? WHERE id = ?");
    stmt.run(enabled ? 1 : 0, updatedAt, id);
  }

  /**
   * Update cron schedule pending envelope id.
   */
  updateCronSchedulePendingEnvelopeId(id: string, pendingEnvelopeId: string | null): void {
    const updatedAt = Date.now();
    const stmt = this.db.prepare(
      "UPDATE cron_schedules SET pending_envelope_id = ?, updated_at = ? WHERE id = ?"
    );
    stmt.run(pendingEnvelopeId, updatedAt, id);
  }

  /**
   * Delete a cron schedule by id.
   */
  deleteCronSchedule(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM cron_schedules WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  private rowToCronSchedule(row: CronScheduleRow): CronSchedule {
    let metadata: Record<string, unknown> | undefined;
    if (row.metadata) {
      try {
        const parsed: unknown = JSON.parse(row.metadata);
        if (parsed && typeof parsed === "object") {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        // Ignore invalid JSON; treat as missing metadata.
      }
    }
    if (metadata && typeof metadata.replyToMessageId === "string") {
      delete metadata.replyToMessageId;
    }
    if (metadata && typeof metadata.replyToEnvelopeId === "string") {
      delete metadata.replyToEnvelopeId;
    }
    const attachments = row.content_attachments ? JSON.parse(row.content_attachments) : undefined;

    const pendingEnvelopeId = row.pending_envelope_id ?? undefined;
    const pendingStatus =
      pendingEnvelopeId && typeof row.pending_status === "string"
        ? (row.pending_status as EnvelopeStatus)
        : undefined;
    const nextDeliverAt =
      pendingEnvelopeId && typeof row.pending_deliver_at === "number"
        ? row.pending_deliver_at
        : undefined;

    return {
      id: row.id,
      agentName: row.agent_name,
      cron: row.cron,
      timezone: row.timezone ?? undefined,
      enabled: row.enabled === 1,
      to: row.to_address,
      content: {
        text: row.content_text ?? undefined,
        attachments,
      },
      metadata,
      pendingEnvelopeId,
      pendingEnvelopeStatus: pendingStatus,
      nextDeliverAt,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    };
  }

  // ==================== Binding Operations ====================

  /**
   * Create a binding between an agent and an adapter.
   */
  createBinding(agentName: string, adapterType: string, adapterToken: string): AgentBinding {
    const id = generateUUID();
    const createdAt = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO agent_bindings (id, agent_name, adapter_type, adapter_token, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(id, agentName, adapterType, adapterToken, createdAt);
    return this.getBindingById(id)!;
  }

  /**
   * Get a binding by ID.
   */
  getBindingById(id: string): AgentBinding | null {
    const stmt = this.db.prepare("SELECT * FROM agent_bindings WHERE id = ?");
    const row = stmt.get(id) as AgentBindingRow | undefined;
    return row ? this.rowToBinding(row) : null;
  }

  /**
   * Get all bindings for an agent.
   */
  getBindingsByAgentName(agentName: string): AgentBinding[] {
    const stmt = this.db.prepare("SELECT * FROM agent_bindings WHERE agent_name = ?");
    const rows = stmt.all(agentName) as AgentBindingRow[];
    return rows.map((row) => this.rowToBinding(row));
  }

  /**
   * Get binding by adapter type and token.
   */
  getBindingByAdapter(adapterType: string, adapterToken: string): AgentBinding | null {
    const stmt = this.db.prepare(
      "SELECT * FROM agent_bindings WHERE adapter_type = ? AND adapter_token = ?"
    );
    const row = stmt.get(adapterType, adapterToken) as AgentBindingRow | undefined;
    return row ? this.rowToBinding(row) : null;
  }

  /**
   * Get binding for an agent by adapter type.
   */
  getAgentBindingByType(agentName: string, adapterType: string): AgentBinding | null {
    const stmt = this.db.prepare(
      "SELECT * FROM agent_bindings WHERE agent_name = ? AND adapter_type = ?"
    );
    const row = stmt.get(agentName, adapterType) as AgentBindingRow | undefined;
    return row ? this.rowToBinding(row) : null;
  }

  /**
   * List all bindings.
   */
  listBindings(): AgentBinding[] {
    const stmt = this.db.prepare("SELECT * FROM agent_bindings ORDER BY created_at DESC");
    const rows = stmt.all() as AgentBindingRow[];
    return rows.map((row) => this.rowToBinding(row));
  }

  /**
   * Delete a binding.
   */
  deleteBinding(agentName: string, adapterType: string): boolean {
    const stmt = this.db.prepare(
      "DELETE FROM agent_bindings WHERE agent_name = ? AND adapter_type = ?"
    );
    const result = stmt.run(agentName, adapterType);
    return result.changes > 0;
  }

  /**
   * Check if an agent has a binding for a specific adapter type.
   */
  hasBinding(agentName: string, adapterType: string): boolean {
    return this.getAgentBindingByType(agentName, adapterType) !== null;
  }

  private rowToBinding(row: AgentBindingRow): AgentBinding {
    return {
      id: row.id,
      agentName: row.agent_name,
      adapterType: row.adapter_type,
      adapterToken: row.adapter_token,
      createdAt: row.created_at,
    };
  }

  // ==================== Agent Run Operations ====================

  /**
   * Create a new agent run record.
   */
  createAgentRun(agentName: string, envelopeIds: string[]): AgentRun {
    const id = generateUUID();
    const startedAt = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO agent_runs (id, agent_name, started_at, envelope_ids, status)
      VALUES (?, ?, ?, ?, 'running')
    `);

    stmt.run(id, agentName, startedAt, JSON.stringify(envelopeIds));
    return this.getAgentRunById(id)!;
  }

  /**
   * Get an agent run by ID.
   */
  getAgentRunById(id: string): AgentRun | null {
    const stmt = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?");
    const row = stmt.get(id) as AgentRunRow | undefined;
    return row ? this.rowToAgentRun(row) : null;
  }

  /**
   * Complete an agent run with success.
   */
  completeAgentRun(id: string, finalResponse: string, contextLength: number | null): void {
    const stmt = this.db.prepare(`
      UPDATE agent_runs
      SET status = 'completed', completed_at = ?, final_response = ?, context_length = ?
      WHERE id = ?
    `);
    stmt.run(Date.now(), finalResponse, contextLength, id);
  }

  /**
   * Fail an agent run with an error.
   */
  failAgentRun(id: string, error: string): void {
    const stmt = this.db.prepare(`
      UPDATE agent_runs
      SET status = 'failed', completed_at = ?, error = ?, context_length = NULL
      WHERE id = ?
    `);
    stmt.run(Date.now(), error, id);
  }

  /**
   * Cancel an agent run (best-effort).
   */
  cancelAgentRun(id: string, reason: string): void {
    const stmt = this.db.prepare(`
      UPDATE agent_runs
      SET status = 'cancelled', completed_at = ?, error = ?, context_length = NULL
      WHERE id = ?
    `);
    stmt.run(Date.now(), reason, id);
  }

  /**
   * Get the current running run for an agent (if any).
   */
  getCurrentRunningAgentRun(agentName: string): AgentRun | null {
    const stmt = this.db.prepare(`
      SELECT * FROM agent_runs
      WHERE agent_name = ? AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const row = stmt.get(agentName) as AgentRunRow | undefined;
    return row ? this.rowToAgentRun(row) : null;
  }

  /**
   * Get the most recent finished run for an agent (completed or failed).
   */
  getLastFinishedAgentRun(agentName: string): AgentRun | null {
    const stmt = this.db.prepare(`
      SELECT * FROM agent_runs
      WHERE agent_name = ? AND status IN ('completed', 'failed', 'cancelled')
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const row = stmt.get(agentName) as AgentRunRow | undefined;
    return row ? this.rowToAgentRun(row) : null;
  }

  /**
   * Count due pending envelopes for an agent.
   *
   * "Due" means: status=pending and deliver_at is missing or <= now.
   */
  countDuePendingEnvelopesForAgent(agentName: string): number {
    const address = `agent:${agentName}`;
    const nowMs = Date.now();
    const stmt = this.db.prepare(`
      SELECT COUNT(*) AS n
      FROM envelopes
      WHERE "to" = ? AND status = 'pending'
        AND (deliver_at IS NULL OR deliver_at <= ?)
    `);
    const row = stmt.get(address, nowMs) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Get recent runs for an agent.
   */
  getAgentRuns(agentName: string, limit = 10): AgentRun[] {
    const stmt = this.db.prepare(`
      SELECT * FROM agent_runs
      WHERE agent_name = ?
      ORDER BY started_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(agentName, limit) as AgentRunRow[];
    return rows.map((row) => this.rowToAgentRun(row));
  }

  /**
   * Get pending envelopes for an agent (oldest first, limited).
   */
  getPendingEnvelopesForAgent(agentName: string, limit: number): Envelope[] {
    const address = `agent:${agentName}`;
    const nowMs = Date.now();
    const stmt = this.db.prepare(`
      SELECT * FROM envelopes
      WHERE "to" = ? AND status = 'pending'
        AND (deliver_at IS NULL OR deliver_at <= ?)
      ORDER BY priority DESC, COALESCE(deliver_at, created_at) ASC, created_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(address, nowMs, limit) as EnvelopeRow[];
    return rows.map((row) => this.rowToEnvelope(row));
  }

  /**
   * Get the subset of destination addresses that the agent sent to since a given time.
   */
  getSentToAddressesForAgentSince(
    agentName: string,
    toAddresses: string[],
    sinceMs: number
  ): string[] {
    if (toAddresses.length === 0) return [];

    const fromAddress = `agent:${agentName}`;
    const placeholders = toAddresses.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      SELECT DISTINCT "to" AS to_address
      FROM envelopes
      WHERE "from" = ?
        AND "to" IN (${placeholders})
        AND created_at >= ?
    `);
    const rows = stmt.all(fromAddress, ...toAddresses, sinceMs) as Array<{ to_address: string }>;
    return rows.map((r) => r.to_address);
  }

  /**
   * List pending envelopes that are due for delivery to channels.
   *
   * Includes immediate (deliver_at NULL) and scheduled (deliver_at <= now) envelopes.
   */
  listDueChannelEnvelopes(limit = 100): Envelope[] {
    const nowMs = Date.now();
    const stmt = this.db.prepare(`
      SELECT * FROM envelopes
      WHERE "to" LIKE 'channel:%'
        AND status = 'pending'
        AND (deliver_at IS NULL OR deliver_at <= ?)
      ORDER BY COALESCE(deliver_at, created_at) ASC, created_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(nowMs, limit) as EnvelopeRow[];
    return rows.map((row) => this.rowToEnvelope(row));
  }

  /**
   * List agent names that have due pending envelopes.
   */
  listAgentNamesWithDueEnvelopes(): string[] {
    const nowMs = Date.now();
    const stmt = this.db.prepare(`
      SELECT DISTINCT substr("to", 7) AS agent_name
      FROM envelopes
      WHERE "to" LIKE 'agent:%'
        AND status = 'pending'
        AND (deliver_at IS NULL OR deliver_at <= ?)
    `);
    const rows = stmt.all(nowMs) as Array<{ agent_name: string }>;
    return rows.map((r) => r.agent_name);
  }

  /**
   * Get the earliest pending scheduled envelope (deliver_at > now).
   */
  getNextScheduledEnvelope(): Envelope | null {
    const nowMs = Date.now();
    const stmt = this.db.prepare(`
      SELECT * FROM envelopes
      WHERE status = 'pending'
        AND deliver_at IS NOT NULL
        AND deliver_at > ?
      ORDER BY deliver_at ASC
      LIMIT 1
    `);
    const row = stmt.get(nowMs) as EnvelopeRow | undefined;
    return row ? this.rowToEnvelope(row) : null;
  }

  /**
   * Update deliver_at for an envelope.
   */
  updateEnvelopeDeliverAt(id: string, deliverAt: number | null): void {
    const stmt = this.db.prepare("UPDATE envelopes SET deliver_at = ? WHERE id = ?");
    stmt.run(deliverAt, id);
  }

  /**
   * Mark multiple envelopes as done.
   */
  markEnvelopesDone(
    envelopeIds: string[],
    options?: {
      reason?: string;
      outcome?: string;
      origin?: EnvelopeOrigin;
    }
  ): void {
    if (envelopeIds.length === 0) return;

    const placeholders = envelopeIds.map(() => "?").join(", ");
    const beforeStmt = this.db.prepare(`
      SELECT * FROM envelopes
      WHERE id IN (${placeholders})
    `);
    const beforeRows = beforeStmt.all(...envelopeIds) as EnvelopeRow[];
    if (beforeRows.length === 0) return;

    const stmt = this.db.prepare(`UPDATE envelopes SET status = 'done' WHERE id IN (${placeholders})`);
    stmt.run(...envelopeIds);

    for (const row of beforeRows) {
      if (row.status === "done") continue;
      const envelope = this.rowToEnvelope({
        ...row,
        status: "done",
      });
      this.emitEnvelopeStatusChanged({
        envelope,
        envelopeId: row.id,
        fromStatus: row.status as EnvelopeStatus,
        toStatus: "done",
        reason: options?.reason,
        outcome: options?.outcome,
        origin: options?.origin ?? this.resolveEnvelopeOrigin(envelope.metadata, "internal"),
        timestampMs: Date.now(),
      });
    }
  }

  /**
   * Mark due pending non-cron envelopes for an agent as done.
   *
   * Used by operator abort flows to clear the agent's inbox immediately.
   */
  markDuePendingNonCronEnvelopesDoneForAgent(
    agentName: string,
    options?: {
      reason?: string;
      outcome?: string;
      origin?: EnvelopeOrigin;
    }
  ): number {
    const address = `agent:${agentName}`;
    const nowMs = Date.now();
    const rows = this.db.prepare(`
      SELECT * FROM envelopes
      WHERE "to" = ?
        AND status = 'pending'
        AND (deliver_at IS NULL OR deliver_at <= ?)
        AND json_type(metadata, '$.cronScheduleId') IS NULL
    `).all(address, nowMs) as EnvelopeRow[];

    const stmt = this.db.prepare(`
      UPDATE envelopes
      SET status = 'done'
      WHERE "to" = ?
        AND status = 'pending'
        AND (deliver_at IS NULL OR deliver_at <= ?)
        AND json_type(metadata, '$.cronScheduleId') IS NULL
    `);
    const result = stmt.run(address, nowMs);

    for (const row of rows) {
      const envelope = this.rowToEnvelope({
        ...row,
        status: "done",
      });
      this.emitEnvelopeStatusChanged({
        envelope,
        envelopeId: row.id,
        fromStatus: "pending",
        toStatus: "done",
        reason: options?.reason,
        outcome: options?.outcome,
        origin: options?.origin ?? this.resolveEnvelopeOrigin(envelope.metadata, "internal"),
        timestampMs: Date.now(),
      });
    }
    return result.changes;
  }

  private rowToAgentRun(row: AgentRunRow): AgentRun {
    return {
      id: row.id,
      agentName: row.agent_name,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      envelopeIds: row.envelope_ids ? JSON.parse(row.envelope_ids) : [],
      finalResponse: row.final_response ?? undefined,
      contextLength: typeof row.context_length === "number" ? row.context_length : undefined,
      status: row.status as "running" | "completed" | "failed" | "cancelled",
      error: row.error ?? undefined,
    };
  }

  private rowToAgentSession(row: AgentSessionRow): AgentSessionRecord {
    return {
      id: row.id,
      agentName: row.agent_name,
      provider: row.provider === "codex" ? "codex" : "claude",
      providerSessionId: row.provider_session_id ?? undefined,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      lastAdapterType: row.last_adapter_type ?? undefined,
      lastChatId: row.last_chat_id ?? undefined,
    };
  }

  private rowToChannelSessionBinding(row: ChannelSessionBindingRow): ChannelSessionBinding {
    return {
      id: row.id,
      agentName: row.agent_name,
      adapterType: row.adapter_type,
      chatId: row.chat_id,
      defaultSessionId: row.default_session_id,
      ownerUserId: row.owner_user_id ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  createAgentSession(input: {
    agentName: string;
    provider: "claude" | "codex";
    adapterType?: string;
    chatId?: string;
  }): AgentSessionRecord {
    const id = generateUUID();
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO agent_sessions
        (id, agent_name, provider, provider_session_id, created_at, last_active_at, last_adapter_type, last_chat_id)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      input.agentName,
      input.provider,
      now,
      now,
      input.adapterType ?? null,
      input.chatId ?? null
    );
    const created = this.getAgentSessionById(id);
    if (!created) {
      throw new Error("Failed to create agent session");
    }
    return created;
  }

  getAgentSessionById(id: string): AgentSessionRecord | null {
    const stmt = this.db.prepare("SELECT * FROM agent_sessions WHERE id = ?");
    const row = stmt.get(id) as AgentSessionRow | undefined;
    return row ? this.rowToAgentSession(row) : null;
  }

  findAgentSessionsByIdPrefix(agentName: string, compactPrefix: string, limit = 50): AgentSessionRecord[] {
    const prefix = compactPrefix.trim().toLowerCase();
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 50;
    const stmt = this.db.prepare(`
      SELECT * FROM agent_sessions
      WHERE agent_name = ?
        AND replace(lower(id), '-', '') LIKE ?
      ORDER BY last_active_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(agentName, `${prefix}%`, n) as AgentSessionRow[];
    return rows.map((row) => this.rowToAgentSession(row));
  }

  findAgentSessionByProviderSessionId(input: {
    agentName: string;
    providerSessionId: string;
    provider?: "claude" | "codex";
  }): AgentSessionRecord | null {
    const providerSessionId = input.providerSessionId.trim();
    if (!providerSessionId) return null;

    if (input.provider) {
      const stmt = this.db.prepare(`
        SELECT * FROM agent_sessions
        WHERE agent_name = ?
          AND provider_session_id = ?
          AND provider = ?
        ORDER BY last_active_at DESC
        LIMIT 1
      `);
      const row = stmt.get(input.agentName, providerSessionId, input.provider) as AgentSessionRow | undefined;
      return row ? this.rowToAgentSession(row) : null;
    }

    const stmt = this.db.prepare(`
      SELECT * FROM agent_sessions
      WHERE agent_name = ?
        AND provider_session_id = ?
      ORDER BY last_active_at DESC
      LIMIT 1
    `);
    const row = stmt.get(input.agentName, providerSessionId) as AgentSessionRow | undefined;
    return row ? this.rowToAgentSession(row) : null;
  }

  listAgentSessionsByAgent(agentName: string, limit = 20): AgentSessionRecord[] {
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 20;
    const stmt = this.db.prepare(`
      SELECT * FROM agent_sessions
      WHERE agent_name = ?
      ORDER BY last_active_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(agentName, n) as AgentSessionRow[];
    return rows.map((row) => this.rowToAgentSession(row));
  }

  updateAgentSessionProviderSessionId(
    sessionId: string,
    providerSessionId: string | null,
    options?: { provider?: "claude" | "codex" }
  ): void {
    if (options?.provider) {
      const stmt = this.db.prepare(`
        UPDATE agent_sessions
        SET provider_session_id = ?, provider = ?
        WHERE id = ?
      `);
      stmt.run(providerSessionId, options.provider, sessionId);
      return;
    }
    const stmt = this.db.prepare(`
      UPDATE agent_sessions
      SET provider_session_id = ?
      WHERE id = ?
    `);
    stmt.run(providerSessionId, sessionId);
  }

  touchAgentSession(
    sessionId: string,
    update?: { lastActiveAt?: number; adapterType?: string; chatId?: string }
  ): void {
    const lastActiveAt = update?.lastActiveAt ?? Date.now();
    const stmt = this.db.prepare(`
      UPDATE agent_sessions
      SET last_active_at = ?,
          last_adapter_type = COALESCE(?, last_adapter_type),
          last_chat_id = COALESCE(?, last_chat_id)
      WHERE id = ?
    `);
    stmt.run(lastActiveAt, update?.adapterType ?? null, update?.chatId ?? null, sessionId);
  }

  getChannelSessionBinding(
    agentName: string,
    adapterType: string,
    chatId: string
  ): ChannelSessionBinding | null {
    const stmt = this.db.prepare(`
      SELECT * FROM channel_session_bindings
      WHERE agent_name = ? AND adapter_type = ? AND chat_id = ?
    `);
    const row = stmt.get(agentName, adapterType, chatId) as ChannelSessionBindingRow | undefined;
    return row ? this.rowToChannelSessionBinding(row) : null;
  }

  private upsertChannelSessionLink(input: {
    agentName: string;
    adapterType: string;
    chatId: string;
    sessionId: string;
    ownerUserId?: string;
    nowMs: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO channel_session_links
        (id, agent_name, adapter_type, chat_id, session_id, owner_user_id, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_name, adapter_type, chat_id, session_id)
      DO UPDATE SET
        owner_user_id = COALESCE(excluded.owner_user_id, channel_session_links.owner_user_id),
        last_seen_at = excluded.last_seen_at
    `);
    stmt.run(
      generateUUID(),
      input.agentName,
      input.adapterType,
      input.chatId,
      input.sessionId,
      input.ownerUserId ?? null,
      input.nowMs,
      input.nowMs
    );
  }

  private upsertChannelSessionBinding(input: {
    agentName: string;
    adapterType: string;
    chatId: string;
    sessionId: string;
    ownerUserId?: string;
    nowMs: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO channel_session_bindings
        (id, agent_name, adapter_type, chat_id, default_session_id, owner_user_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_name, adapter_type, chat_id)
      DO UPDATE SET
        default_session_id = excluded.default_session_id,
        owner_user_id = COALESCE(excluded.owner_user_id, channel_session_bindings.owner_user_id),
        updated_at = excluded.updated_at
    `);
    stmt.run(
      generateUUID(),
      input.agentName,
      input.adapterType,
      input.chatId,
      input.sessionId,
      input.ownerUserId ?? null,
      input.nowMs
    );
  }

  getOrCreateChannelDefaultSession(input: {
    agentName: string;
    adapterType: string;
    chatId: string;
    ownerUserId?: string;
    provider: "claude" | "codex";
  }): { binding: ChannelSessionBinding; session: AgentSessionRecord; created: boolean } {
    return this.runInTransaction(() => {
      const nowMs = Date.now();
      const currentBinding = this.getChannelSessionBinding(input.agentName, input.adapterType, input.chatId);
      if (currentBinding) {
        const existingSession = this.getAgentSessionById(currentBinding.defaultSessionId);
        if (existingSession && existingSession.agentName === input.agentName) {
          this.upsertChannelSessionBinding({
            agentName: input.agentName,
            adapterType: input.adapterType,
            chatId: input.chatId,
            sessionId: existingSession.id,
            ownerUserId: input.ownerUserId,
            nowMs,
          });
          this.upsertChannelSessionLink({
            agentName: input.agentName,
            adapterType: input.adapterType,
            chatId: input.chatId,
            sessionId: existingSession.id,
            ownerUserId: input.ownerUserId,
            nowMs,
          });
          this.touchAgentSession(existingSession.id, {
            lastActiveAt: nowMs,
            adapterType: input.adapterType,
            chatId: input.chatId,
          });
          const binding = this.getChannelSessionBinding(input.agentName, input.adapterType, input.chatId);
          const session = this.getAgentSessionById(existingSession.id);
          if (binding && session) {
            return { binding, session, created: false };
          }
        }
      }

      const createdSession = this.createAgentSession({
        agentName: input.agentName,
        provider: input.provider,
        adapterType: input.adapterType,
        chatId: input.chatId,
      });
      this.upsertChannelSessionBinding({
        agentName: input.agentName,
        adapterType: input.adapterType,
        chatId: input.chatId,
        sessionId: createdSession.id,
        ownerUserId: input.ownerUserId,
        nowMs,
      });
      this.upsertChannelSessionLink({
        agentName: input.agentName,
        adapterType: input.adapterType,
        chatId: input.chatId,
        sessionId: createdSession.id,
        ownerUserId: input.ownerUserId,
        nowMs,
      });
      const binding = this.getChannelSessionBinding(input.agentName, input.adapterType, input.chatId);
      if (!binding) {
        throw new Error("Failed to create channel session binding");
      }
      return { binding, session: createdSession, created: true };
    });
  }

  switchChannelDefaultSession(input: {
    agentName: string;
    adapterType: string;
    chatId: string;
    targetSessionId: string;
    ownerUserId?: string;
  }): { oldSessionId?: string; newSessionId: string } {
    return this.runInTransaction(() => {
      const nowMs = Date.now();
      const target = this.getAgentSessionById(input.targetSessionId);
      if (!target || target.agentName !== input.agentName) {
        throw new Error("Session not found");
      }

      const current = this.getChannelSessionBinding(input.agentName, input.adapterType, input.chatId);
      this.upsertChannelSessionBinding({
        agentName: input.agentName,
        adapterType: input.adapterType,
        chatId: input.chatId,
        sessionId: target.id,
        ownerUserId: input.ownerUserId,
        nowMs,
      });
      this.upsertChannelSessionLink({
        agentName: input.agentName,
        adapterType: input.adapterType,
        chatId: input.chatId,
        sessionId: target.id,
        ownerUserId: input.ownerUserId,
        nowMs,
      });
      this.touchAgentSession(target.id, {
        lastActiveAt: nowMs,
        adapterType: input.adapterType,
        chatId: input.chatId,
      });
      return { oldSessionId: current?.defaultSessionId, newSessionId: target.id };
    });
  }

  createFreshChannelSessionAndSetDefault(input: {
    agentName: string;
    adapterType: string;
    chatId: string;
    ownerUserId?: string;
    provider: "claude" | "codex";
  }): { oldSessionId?: string; newSession: AgentSessionRecord } {
    return this.runInTransaction(() => {
      const nowMs = Date.now();
      const current = this.getChannelSessionBinding(input.agentName, input.adapterType, input.chatId);
      const fresh = this.createAgentSession({
        agentName: input.agentName,
        provider: input.provider,
        adapterType: input.adapterType,
        chatId: input.chatId,
      });
      this.upsertChannelSessionBinding({
        agentName: input.agentName,
        adapterType: input.adapterType,
        chatId: input.chatId,
        sessionId: fresh.id,
        ownerUserId: input.ownerUserId,
        nowMs,
      });
      this.upsertChannelSessionLink({
        agentName: input.agentName,
        adapterType: input.adapterType,
        chatId: input.chatId,
        sessionId: fresh.id,
        ownerUserId: input.ownerUserId,
        nowMs,
      });
      return { oldSessionId: current?.defaultSessionId, newSession: fresh };
    });
  }

  listSessionsForScope(input: {
    agentName: string;
    scope: SessionListScope;
    adapterType: string;
    chatId: string;
    ownerUserId?: string;
    limit?: number;
    offset?: number;
  }): SessionListItem[] {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 10)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const fetchLimit = Math.max(limit + offset, 20) * 4;
    const params: Array<string | number> = [input.agentName];
    const where: string[] = ["l.agent_name = ?"];

    if (input.scope === "current-chat") {
      where.push("l.adapter_type = ?");
      where.push("l.chat_id = ?");
      params.push(input.adapterType, input.chatId);
    } else if (input.scope === "my-chats") {
      if (!input.ownerUserId) return [];
      where.push("l.owner_user_id = ?");
      params.push(input.ownerUserId);
    }

    const stmt = this.db.prepare(`
      SELECT
        l.id,
        l.agent_name,
        l.adapter_type,
        l.chat_id,
        l.session_id,
        l.owner_user_id,
        l.first_seen_at,
        l.last_seen_at,
        s.created_at,
        s.last_active_at,
        s.provider,
        s.provider_session_id,
        s.last_adapter_type,
        s.last_chat_id
      FROM channel_session_links l
      INNER JOIN agent_sessions s
        ON s.id = l.session_id
      WHERE ${where.join(" AND ")}
      ORDER BY s.last_active_at DESC, l.last_seen_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(...params, fetchLimit) as SessionLinkWithSessionRow[];

    const bySession = new Map<string, SessionListItem>();
    for (const row of rows) {
      if (bySession.has(row.session_id)) continue;
      bySession.set(row.session_id, {
        session: this.rowToAgentSession({
          id: row.session_id,
          agent_name: row.agent_name,
          provider: row.provider,
          provider_session_id: row.provider_session_id,
          created_at: row.created_at,
          last_active_at: row.last_active_at,
          last_adapter_type: row.last_adapter_type,
          last_chat_id: row.last_chat_id,
        }),
        link: {
          adapterType: row.adapter_type,
          chatId: row.chat_id,
          ownerUserId: row.owner_user_id ?? undefined,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
        },
      });
    }

    return [...bySession.values()].slice(offset, offset + limit);
  }

  countSessionsForScope(input: {
    agentName: string;
    scope: SessionListScope;
    adapterType: string;
    chatId: string;
    ownerUserId?: string;
  }): number {
    const params: Array<string | number> = [input.agentName];
    const where: string[] = ["l.agent_name = ?"];
    if (input.scope === "current-chat") {
      where.push("l.adapter_type = ?");
      where.push("l.chat_id = ?");
      params.push(input.adapterType, input.chatId);
    } else if (input.scope === "my-chats") {
      if (!input.ownerUserId) return 0;
      where.push("l.owner_user_id = ?");
      params.push(input.ownerUserId);
    }

    const stmt = this.db.prepare(`
      SELECT COUNT(DISTINCT l.session_id) AS n
      FROM channel_session_links l
      WHERE ${where.join(" AND ")}
    `);
    const row = stmt.get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  clearAgentSessionProviderHandles(agentName: string): void {
    const stmt = this.db.prepare(`
      UPDATE agent_sessions
      SET provider_session_id = NULL
      WHERE agent_name = ?
    `);
    stmt.run(agentName);
  }

  // ==================== Config Operations ====================

  /**
   * Get a config value.
   */
  getConfig(key: string): string | null {
    const stmt = this.db.prepare("SELECT value FROM config WHERE key = ?");
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Set a config value.
   */
  setConfig(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO config (key, value, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, value, Date.now());
  }

  /**
   * Check if setup is complete.
   */
  isSetupComplete(): boolean {
    return this.getConfig("setup_completed") === "true";
  }

  /**
   * Mark setup as complete.
   */
  markSetupComplete(): void {
    this.setConfig("setup_completed", "true");
  }

  /**
   * Set the admin token.
   */
  setAdminToken(token: string): void {
    const tokenHash = hashToken(token);
    this.setConfig("admin_token_hash", tokenHash);
  }

  /**
   * Verify an admin token.
   */
  verifyAdminToken(token: string): boolean {
    const storedHash = this.getConfig("admin_token_hash");
    if (!storedHash) return false;
    return verifyToken(token, storedHash);
  }

  /**
   * Get the boss name.
   */
  getBossName(): string | null {
    return this.getConfig("boss_name");
  }

  /**
   * Get the boss timezone (IANA).
   *
   * Used for all displayed timestamps. Falls back to the daemon host timezone when missing.
   */
  getBossTimezone(): string {
    const tz = (this.getConfig("boss_timezone") ?? "").trim();
    return tz || getDaemonIanaTimeZone();
  }

  /**
   * Set the boss name.
   */
  setBossName(name: string): void {
    this.setConfig("boss_name", name);
  }

  /**
   * Get the boss ID for an adapter type.
   */
  getAdapterBossId(adapterType: string): string | null {
    const ids = this.getAdapterBossIds(adapterType);
    if (ids.length > 0) return ids[0]!;
    return this.getConfig(`adapter_boss_id_${adapterType}`);
  }

  /**
   * Get all boss IDs for an adapter type.
   */
  getAdapterBossIds(adapterType: string): string[] {
    const listRaw = (this.getConfig(`adapter_boss_ids_${adapterType}`) ?? "").trim();
    if (listRaw.length > 0) {
      return listRaw
        .split(",")
        .map((value) => value.trim().replace(/^@/, ""))
        .filter((value) => value.length > 0);
    }

    const singular = (this.getConfig(`adapter_boss_id_${adapterType}`) ?? "").trim();
    if (!singular) return [];
    return [singular.replace(/^@/, "")];
  }

  /**
   * Set the boss ID for an adapter type.
   */
  setAdapterBossId(adapterType: string, bossId: string): void {
    const normalized = bossId.trim().replace(/^@/, "");
    this.setConfig(`adapter_boss_id_${adapterType}`, normalized);
    this.setConfig(`adapter_boss_ids_${adapterType}`, normalized ? normalized : "");
  }

  /**
   * Set all boss IDs for an adapter type.
   */
  setAdapterBossIds(adapterType: string, bossIds: string[]): void {
    const normalized = bossIds
      .map((id) => id.trim().replace(/^@/, ""))
      .filter((id) => id.length > 0);
    this.setConfig(`adapter_boss_ids_${adapterType}`, normalized.join(","));
    this.setConfig(`adapter_boss_id_${adapterType}`, normalized[0] ?? "");
  }

  getRuntimeSessionConcurrency(): { perAgent: number; global: number } {
    const perAgentRaw = (this.getConfig("runtime_session_concurrency_per_agent") ?? "").trim();
    const globalRaw = (this.getConfig("runtime_session_concurrency_global") ?? "").trim();

    const parsedPerAgent = Number(perAgentRaw);
    const parsedGlobal = Number(globalRaw);

    const perAgent = Number.isFinite(parsedPerAgent) && parsedPerAgent > 0
      ? Math.max(1, Math.min(64, Math.trunc(parsedPerAgent)))
      : DEFAULT_SESSION_CONCURRENCY_PER_AGENT;
    const global = Number.isFinite(parsedGlobal) && parsedGlobal > 0
      ? Math.max(1, Math.min(256, Math.trunc(parsedGlobal)))
      : DEFAULT_SESSION_CONCURRENCY_GLOBAL;

    return { perAgent, global: Math.max(perAgent, global) };
  }

  setRuntimeSessionConcurrency(input: { perAgent: number; global: number }): void {
    const perAgent = Math.max(1, Math.min(64, Math.trunc(input.perAgent)));
    const global = Math.max(perAgent, Math.min(256, Math.trunc(input.global)));
    this.setConfig("runtime_session_concurrency_per_agent", String(perAgent));
    this.setConfig("runtime_session_concurrency_global", String(global));
  }
}
