import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { SCHEMA_SQL } from "./schema.js";
import type { Agent, AgentPermissionLevel, RegisterAgentInput } from "../../agent/types.js";
import type { Envelope, CreateEnvelopeInput, EnvelopeStatus } from "../../envelope/types.js";
import type { SessionPolicyConfig } from "../../shared/session-policy.js";
import {
  DEFAULT_AGENT_AUTO_LEVEL,
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_REASONING_EFFORT,
} from "../../shared/defaults.js";
import { generateToken, hashToken, verifyToken } from "../../agent/auth.js";
import { generateUUID } from "../../shared/uuid.js";
import { assertValidAgentName } from "../../shared/validation.js";

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
  auto_level: string | null;
  permission_level: string | null;
  session_policy: string | null;
  created_at: string;
  last_seen_at: string | null;
  metadata: string | null;
}

interface EnvelopeRow {
  id: string;
  from: string;
  to: string;
  from_boss: number;
  content_text: string | null;
  content_attachments: string | null;
  deliver_at: string | null;
  status: string;
  created_at: string;
  metadata: string | null;
}

interface AgentBindingRow {
  id: string;
  agent_name: string;
  adapter_type: string;
  adapter_token: string;
  created_at: string;
}

interface AgentRunRow {
  id: string;
  agent_name: string;
  started_at: number;
  completed_at: number | null;
  envelope_ids: string | null;
  final_response: string | null;
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
  createdAt: string;
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
  status: "running" | "completed" | "failed";
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
    this.runMigrations();
    this.db.exec(SCHEMA_SQL);
  }

  private runMigrations(): void {
    // Migrate envelopes.deliver_at column (added after initial schema)
    const envelopeColumns = this.db.prepare("PRAGMA table_info(envelopes)").all() as Array<{
      name: string;
    }>;
    if (envelopeColumns.length > 0) {
      const hasDeliverAt = envelopeColumns.some((c) => c.name === "deliver_at");
      if (!hasDeliverAt) {
        this.db.exec("ALTER TABLE envelopes ADD COLUMN deliver_at TEXT");
      }
    }

    // Migrate agents.permission_level and agents.session_policy columns
    const agentColumns = this.db.prepare("PRAGMA table_info(agents)").all() as Array<{
      name: string;
    }>;
    if (agentColumns.length > 0) {
      const hasPermissionLevel = agentColumns.some((c) => c.name === "permission_level");
      if (!hasPermissionLevel) {
        this.db.exec(
          `ALTER TABLE agents ADD COLUMN permission_level TEXT DEFAULT '${DEFAULT_AGENT_PERMISSION_LEVEL}'`
        );
      }
      const hasSessionPolicy = agentColumns.some((c) => c.name === "session_policy");
      if (!hasSessionPolicy) {
        this.db.exec("ALTER TABLE agents ADD COLUMN session_policy TEXT");
      }

      // Migrate existing data from metadata to new columns
      if (!hasPermissionLevel || !hasSessionPolicy) {
        this.db.exec(`
          UPDATE agents
          SET permission_level = json_extract(metadata, '$.permissionLevel')
          WHERE json_extract(metadata, '$.permissionLevel') IS NOT NULL
            AND (permission_level IS NULL OR permission_level = '${DEFAULT_AGENT_PERMISSION_LEVEL}');

          UPDATE agents
          SET session_policy = json_extract(metadata, '$.sessionPolicy')
          WHERE json_extract(metadata, '$.sessionPolicy') IS NOT NULL
            AND session_policy IS NULL;
        `);
      }
    }
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
    const createdAt = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO agents (name, token, description, workspace, provider, model, reasoning_effort, auto_level, permission_level, session_policy, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      input.name,
      token,  // store raw token directly
      input.description ?? null,
      input.workspace ?? null,
      input.provider ?? DEFAULT_AGENT_PROVIDER,
      input.model ?? null,
      input.reasoningEffort ?? DEFAULT_AGENT_REASONING_EFFORT,
      input.autoLevel ?? DEFAULT_AGENT_AUTO_LEVEL,
      input.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL,
      input.sessionPolicy ? JSON.stringify(input.sessionPolicy) : null,
      createdAt,
      input.metadata ? JSON.stringify(input.metadata) : null
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
    stmt.run(new Date().toISOString(), name);
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
      autoLevel?: "low" | "medium" | "high" | null;
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
    if (update.autoLevel !== undefined) {
      updates.push("auto_level = ?");
      params.push(update.autoLevel);
    }

    if (updates.length === 0) {
      return this.getAgentByName(agent.name)!;
    }

    const stmt = this.db.prepare(`UPDATE agents SET ${updates.join(", ")} WHERE name = ?`);
    stmt.run(...params, agent.name);

    return this.getAgentByName(agent.name)!;
  }

  /**
   * Update agent metadata.
   */
  updateAgentMetadata(name: string, metadata: Record<string, unknown> | null): void {
    const stmt = this.db.prepare("UPDATE agents SET metadata = ? WHERE name = ?");
    stmt.run(metadata ? JSON.stringify(metadata) : null, name);
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
      maxTokens?: number;
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
      if (typeof update.maxTokens === "number") {
        merged.maxTokens = update.maxTokens;
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
    if (row.permission_level === "restricted" || row.permission_level === "standard" || row.permission_level === "privileged") {
      permissionLevel = row.permission_level;
    }

    // Parse session policy
    let sessionPolicy: SessionPolicyConfig | undefined;
    if (row.session_policy) {
      try {
        sessionPolicy = JSON.parse(row.session_policy) as SessionPolicyConfig;
      } catch {
        // ignore invalid JSON
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
      autoLevel: (row.auto_level as 'low' | 'medium' | 'high') ?? undefined,
      permissionLevel,
      sessionPolicy,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  // ==================== Envelope Operations ====================

  /**
   * Create a new envelope.
   */
  createEnvelope(input: CreateEnvelopeInput): Envelope {
    const id = generateUUID();
    const createdAt = new Date().toISOString();

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
   * List envelopes for an address (inbox or outbox).
   */
  listEnvelopes(options: {
    address: string;
    box: "inbox" | "outbox";
    status?: EnvelopeStatus;
    limit?: number;
  }): Envelope[] {
    const { address, box, status, limit } = options;
    const column = box === "inbox" ? '"to"' : '"from"';

    let sql = `SELECT * FROM envelopes WHERE ${column} = ?`;
    const params: (string | number)[] = [address];

    if (status) {
      sql += " AND status = ?";
      params.push(status);
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

  // ==================== Binding Operations ====================

  /**
   * Create a binding between an agent and an adapter.
   */
  createBinding(agentName: string, adapterType: string, adapterToken: string): AgentBinding {
    const id = generateUUID();
    const createdAt = new Date().toISOString();

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
  completeAgentRun(id: string, finalResponse: string): void {
    const stmt = this.db.prepare(`
      UPDATE agent_runs
      SET status = 'completed', completed_at = ?, final_response = ?
      WHERE id = ?
    `);
    stmt.run(Date.now(), finalResponse, id);
  }

  /**
   * Fail an agent run with an error.
   */
  failAgentRun(id: string, error: string): void {
    const stmt = this.db.prepare(`
      UPDATE agent_runs
      SET status = 'failed', completed_at = ?, error = ?
      WHERE id = ?
    `);
    stmt.run(Date.now(), error, id);
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
    const nowIso = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT * FROM envelopes
      WHERE "to" = ? AND status = 'pending'
        AND (deliver_at IS NULL OR deliver_at <= ?)
      ORDER BY COALESCE(deliver_at, created_at) ASC, created_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(address, nowIso, limit) as EnvelopeRow[];
    return rows.map((row) => this.rowToEnvelope(row));
  }

  /**
   * Get the subset of destination addresses that the agent sent to since a given time.
   */
  getSentToAddressesForAgentSince(
    agentName: string,
    toAddresses: string[],
    sinceIso: string
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
    const rows = stmt.all(fromAddress, ...toAddresses, sinceIso) as Array<{ to_address: string }>;
    return rows.map((r) => r.to_address);
  }

  /**
   * List pending envelopes that are due for delivery to channels.
   *
   * Includes immediate (deliver_at NULL) and scheduled (deliver_at <= now) envelopes.
   */
  listDueChannelEnvelopes(limit = 100): Envelope[] {
    const nowIso = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT * FROM envelopes
      WHERE "to" LIKE 'channel:%'
        AND status = 'pending'
        AND (deliver_at IS NULL OR deliver_at <= ?)
      ORDER BY COALESCE(deliver_at, created_at) ASC, created_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(nowIso, limit) as EnvelopeRow[];
    return rows.map((row) => this.rowToEnvelope(row));
  }

  /**
   * List agent names that have due pending envelopes.
   */
  listAgentNamesWithDueEnvelopes(): string[] {
    const nowIso = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT DISTINCT substr("to", 7) AS agent_name
      FROM envelopes
      WHERE "to" LIKE 'agent:%'
        AND status = 'pending'
        AND (deliver_at IS NULL OR deliver_at <= ?)
    `);
    const rows = stmt.all(nowIso) as Array<{ agent_name: string }>;
    return rows.map((r) => r.agent_name);
  }

  /**
   * Get the earliest pending scheduled envelope (deliver_at > now).
   */
  getNextScheduledEnvelope(): Envelope | null {
    const nowIso = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT * FROM envelopes
      WHERE status = 'pending'
        AND deliver_at IS NOT NULL
        AND deliver_at > ?
      ORDER BY deliver_at ASC
      LIMIT 1
    `);
    const row = stmt.get(nowIso) as EnvelopeRow | undefined;
    return row ? this.rowToEnvelope(row) : null;
  }

  /**
   * Update deliver_at for an envelope.
   */
  updateEnvelopeDeliverAt(id: string, deliverAt: string | null): void {
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

  private rowToAgentRun(row: AgentRunRow): AgentRun {
    return {
      id: row.id,
      agentName: row.agent_name,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      envelopeIds: row.envelope_ids ? JSON.parse(row.envelope_ids) : [],
      finalResponse: row.final_response ?? undefined,
      status: row.status as "running" | "completed" | "failed",
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
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, value);
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
   * Get the default provider.
   */
  getDefaultProvider(): 'claude' | 'codex' | null {
    const provider = this.getConfig("default_provider");
    return provider as 'claude' | 'codex' | null;
  }

  /**
   * Set the default provider.
   */
  setDefaultProvider(provider: 'claude' | 'codex'): void {
    this.setConfig("default_provider", provider);
  }

  /**
   * Get the boss name.
   */
  getBossName(): string | null {
    return this.getConfig("boss_name");
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
