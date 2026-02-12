import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { SCHEMA_SQL } from "./schema.js";
import type { Agent, AgentPermissionLevel, RegisterAgentInput } from "../../agent/types.js";
import type { Envelope, CreateEnvelopeInput, EnvelopeStatus } from "../../envelope/types.js";
import type { CronSchedule, CreateCronScheduleInput } from "../../cron/types.js";
import type { SessionPolicyConfig } from "../../shared/session-policy.js";
import {
  BACKGROUND_AGENT_NAME,
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  getDefaultAgentDescription,
} from "../../shared/defaults.js";
import type { AgentRole } from "../../shared/agent-role.js";
import {
  inferAgentRoleFromBindingCount,
  parseAgentRoleFromMetadata,
  withAgentRoleMetadata,
} from "../../shared/agent-role.js";
import { generateToken, hashToken, verifyToken } from "../../agent/auth.js";
import { generateUUID } from "../../shared/uuid.js";
import { assertValidAgentName } from "../../shared/validation.js";
import { getDaemonIanaTimeZone } from "../../shared/timezone.js";

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

/**
 * SQLite database wrapper for Hi-Boss.
 */
export class HiBossDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(SCHEMA_SQL);
    this.assertSchemaCompatible();
    this.reconcileStaleAgentRunsOnStartup();
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
      envelopes: [
        "id",
        "from",
        "to",
        "from_boss",
        "content_text",
        "content_attachments",
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
    };

    const expectedIntegerColumns: Array<{ table: string; column: string }> = [
      { table: "config", column: "created_at" },
      { table: "agents", column: "created_at" },
      { table: "agents", column: "last_seen_at" },
      { table: "agent_bindings", column: "created_at" },
      { table: "envelopes", column: "created_at" },
      { table: "envelopes", column: "deliver_at" },
      { table: "cron_schedules", column: "created_at" },
      { table: "cron_schedules", column: "updated_at" },
      { table: "agent_runs", column: "started_at" },
      { table: "agent_runs", column: "completed_at" },
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
    this.db.prepare("DELETE FROM agent_bindings").run();
    this.db.prepare("DELETE FROM agent_runs").run();
    this.db.prepare("DELETE FROM agents").run();
  }

  // ==================== Agent Operations ====================

  /**
   * Register a new agent and return the token.
   */
  registerAgent(input: RegisterAgentInput): { agent: Agent; token: string } {
    assertValidAgentName(input.name);
    if (input.name.trim().toLowerCase() === BACKGROUND_AGENT_NAME) {
      throw new Error(`Reserved agent name: ${BACKGROUND_AGENT_NAME}`);
    }

    const existing = this.getAgentByNameCaseInsensitive(input.name);
    if (existing) {
      throw new Error("Agent already exists");
    }

    const token = generateToken();
    const createdAt = Date.now();
    const metadataWithRole = withAgentRoleMetadata({
      metadata: input.metadata,
      role: input.role,
      stripSessionHandle: true,
    });

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
      metadataWithRole ? JSON.stringify(metadataWithRole) : null
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
      role?: AgentRole;
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

    if (updates.length === 0 && update.role === undefined) {
      return this.getAgentByName(agent.name)!;
    }

    if (updates.length > 0) {
      const stmt = this.db.prepare(`UPDATE agents SET ${updates.join(", ")} WHERE name = ?`);
      stmt.run(...params, agent.name);
    }

    if (update.role !== undefined) {
      const current = this.getAgentByName(agent.name)!;
      const nextMetadata = withAgentRoleMetadata({
        metadata: current.metadata,
        role: update.role,
      });
      const mdStmt = this.db.prepare("UPDATE agents SET metadata = ? WHERE name = ?");
      mdStmt.run(nextMetadata ? JSON.stringify(nextMetadata) : null, agent.name);
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

    const role = parseAgentRoleFromMetadata(agent.metadata);
    const withRole = withAgentRoleMetadata({
      metadata: metadata ?? undefined,
      role,
      stripSessionHandle: true,
    });

    const existingSessionHandle = (() => {
      const current = agent.metadata;
      if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
      return (current as Record<string, unknown>).sessionHandle;
    })();

    if (existingSessionHandle === undefined) {
      const stmt = this.db.prepare("UPDATE agents SET metadata = ? WHERE name = ?");
      stmt.run(withRole ? JSON.stringify(withRole) : null, agent.name);
      return;
    }

    const nextWithSessionHandle = {
      ...(withRole ?? {}),
      sessionHandle: existingSessionHandle,
    };
    const stmt = this.db.prepare("UPDATE agents SET metadata = ? WHERE name = ?");
    stmt.run(JSON.stringify(nextWithSessionHandle), agent.name);
  }

  setAgentRole(name: string, role: AgentRole): Agent {
    return this.updateAgentFields(name, { role });
  }

  backfillLegacyAgentRolesFromBindings(): {
    updated: number;
    speaker: number;
    leader: number;
  } {
    const agents = this.listAgents();
    if (agents.length === 0) {
      return { updated: 0, speaker: 0, leader: 0 };
    }

    const bindingCountByAgent = new Map<string, number>();
    for (const binding of this.listBindings()) {
      bindingCountByAgent.set(binding.agentName, (bindingCountByAgent.get(binding.agentName) ?? 0) + 1);
    }

    const patchTargets = agents
      .filter((agent) => !parseAgentRoleFromMetadata(agent.metadata))
      .map((agent) => ({
        name: agent.name,
        metadata: agent.metadata,
        role: inferAgentRoleFromBindingCount(bindingCountByAgent.get(agent.name) ?? 0),
      }));

    if (patchTargets.length === 0) {
      return { updated: 0, speaker: 0, leader: 0 };
    }

    const updateStmt = this.db.prepare("UPDATE agents SET metadata = ? WHERE name = ?");

    this.db.transaction(() => {
      for (const target of patchTargets) {
        const nextMetadata = withAgentRoleMetadata({
          metadata: target.metadata,
          role: target.role,
        });
        updateStmt.run(nextMetadata ? JSON.stringify(nextMetadata) : null, target.name);
      }
    })();

    let speaker = 0;
    let leader = 0;
    for (const target of patchTargets) {
      if (target.role === "speaker") speaker += 1;
      if (target.role === "leader") leader += 1;
    }

    return {
      updated: patchTargets.length,
      speaker,
      leader,
    };
  }

  getAgentRoleCounts(): { speaker: number; leader: number } {
    const counts = { speaker: 0, leader: 0 };
    const bindingCountByAgent = new Map<string, number>();
    for (const binding of this.listBindings()) {
      bindingCountByAgent.set(binding.agentName, (bindingCountByAgent.get(binding.agentName) ?? 0) + 1);
    }

    for (const agent of this.listAgents()) {
      const role =
        parseAgentRoleFromMetadata(agent.metadata) ??
        inferAgentRoleFromBindingCount(bindingCountByAgent.get(agent.name) ?? 0);
      if (role === "speaker") counts.speaker += 1;
      if (role === "leader") counts.leader += 1;
    }

    return counts;
  }

  hasRequiredAgentRoles(): boolean {
    const counts = this.getAgentRoleCounts();
    return counts.speaker > 0 && counts.leader > 0;
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

  private rowToAgent(row: AgentRow): Agent {
    // Parse permission level
    let permissionLevel: AgentPermissionLevel | undefined;
    if (
      row.permission_level === "restricted" ||
      row.permission_level === "standard" ||
      row.permission_level === "privileged" ||
      row.permission_level === "boss"
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

    const role = parseAgentRoleFromMetadata(metadata);

    return {
      name: row.name,
      token: row.token,
      description: row.description ?? undefined,
      workspace: row.workspace ?? undefined,
      provider: (row.provider as 'claude' | 'codex') ?? undefined,
      model: row.model ?? undefined,
      reasoningEffort: (row.reasoning_effort as 'none' | 'low' | 'medium' | 'high' | 'xhigh') ?? undefined,
      permissionLevel,
      role,
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
      INSERT INTO envelopes (id, "from", "to", from_boss, content_text, content_attachments, deliver_at, status, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.from,
      input.to,
      input.fromBoss ? 1 : 0,
      input.content.text ?? null,
      input.content.attachments ? JSON.stringify(input.content.attachments) : null,
      input.deliverAt ?? null,
      "pending",
      createdAt,
      input.metadata ? JSON.stringify(input.metadata) : null
    );

    return this.getEnvelopeById(id)!;
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
  }): Envelope[] {
    const { from, to, status, limit, dueOnly } = options;

    let sql = `SELECT * FROM envelopes WHERE "from" = ? AND "to" = ? AND status = ?`;
    const params: (string | number)[] = [from, to, status];

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
  updateEnvelopeStatus(id: string, status: EnvelopeStatus): void {
    const stmt = this.db.prepare("UPDATE envelopes SET status = ? WHERE id = ?");
    stmt.run(status, id);
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
      deliverAt: row.deliver_at ?? undefined,
      status: row.status as EnvelopeStatus,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
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
      ORDER BY COALESCE(deliver_at, created_at) ASC, created_at ASC
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
  markEnvelopesDone(envelopeIds: string[]): void {
    if (envelopeIds.length === 0) return;

    const placeholders = envelopeIds.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      UPDATE envelopes SET status = 'done' WHERE id IN (${placeholders})
    `);
    stmt.run(...envelopeIds);
  }

  /**
   * Mark due pending non-cron envelopes for an agent as done.
   *
   * Used by operator abort flows to clear the agent's inbox immediately.
   */
  markDuePendingNonCronEnvelopesDoneForAgent(agentName: string): number {
    const address = `agent:${agentName}`;
    const nowMs = Date.now();
    const stmt = this.db.prepare(`
      UPDATE envelopes
      SET status = 'done'
      WHERE "to" = ?
        AND status = 'pending'
        AND (deliver_at IS NULL OR deliver_at <= ?)
        AND json_type(metadata, '$.cronScheduleId') IS NULL
    `);
    const result = stmt.run(address, nowMs);
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
   * Set the boss token.
   */
  setBossToken(token: string): void {
    const tokenHash = hashToken(token);
    this.setConfig("boss_token_hash", tokenHash);
  }

  /**
   * Verify a boss token.
   */
  verifyBossToken(token: string): boolean {
    const storedHash = this.getConfig("boss_token_hash");
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
    return this.getConfig(`adapter_boss_id_${adapterType}`);
  }

  /**
   * Set the boss ID for an adapter type.
   */
  setAdapterBossId(adapterType: string, bossId: string): void {
    this.setConfig(`adapter_boss_id_${adapterType}`, bossId);
  }
}
