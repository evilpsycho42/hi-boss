/**
 * SQLite schema definitions for Hi-Boss.
 */

import {
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_RUN_STATUS,
  DEFAULT_ENVELOPE_STATUS,
} from "../../shared/defaults.js";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

	CREATE TABLE IF NOT EXISTS agents (
	  name TEXT PRIMARY KEY,       -- unique identifier (alphanumeric, hyphens)
	  token TEXT UNIQUE NOT NULL,  -- agent token (short identifier; stored as plaintext)
	  description TEXT,
	  workspace TEXT,
  provider TEXT DEFAULT '${DEFAULT_AGENT_PROVIDER}',
  model TEXT,
  reasoning_effort TEXT,
  permission_level TEXT DEFAULT '${DEFAULT_AGENT_PERMISSION_LEVEL}',
  session_policy TEXT,           -- JSON blob for SessionPolicyConfig
  created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  last_seen_at INTEGER,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  from_boss INTEGER DEFAULT 0,
  content_text TEXT,
  content_attachments TEXT,
  deliver_at INTEGER,         -- unix epoch ms (UTC) (not-before delivery)
  status TEXT DEFAULT '${DEFAULT_ENVELOPE_STATUS}',
  created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS cron_schedules (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,   -- owner agent (sender)
  cron TEXT NOT NULL,         -- cron expression
  timezone TEXT,              -- IANA timezone (null means inherit boss timezone)
  enabled INTEGER DEFAULT 1,
  to_address TEXT NOT NULL,
  content_text TEXT,
  content_attachments TEXT,
  metadata TEXT,              -- JSON blob for envelope template metadata
  pending_envelope_id TEXT,   -- envelope id for the next scheduled occurrence (nullable)
  created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at INTEGER,
  FOREIGN KEY (agent_name) REFERENCES agents(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_bindings (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,    -- references agents(name)
  adapter_type TEXT NOT NULL,
  adapter_token TEXT NOT NULL,
  created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  UNIQUE(adapter_type, adapter_token),
  FOREIGN KEY (agent_name) REFERENCES agents(name) ON DELETE CASCADE
);

-- Each agent can have at most one binding per adapter type.
-- Older versions relied on application-level enforcement; dedupe before enforcing.
DELETE FROM agent_bindings
WHERE rowid NOT IN (
  SELECT MAX(rowid)
  FROM agent_bindings
  GROUP BY agent_name, adapter_type
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  envelope_ids TEXT,           -- JSON array of processed envelope IDs
  final_response TEXT,         -- stored for auditing
  context_length INTEGER,      -- context length (tokens) when available
  status TEXT DEFAULT '${DEFAULT_AGENT_RUN_STATUS}', -- running, completed, failed, cancelled
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_envelopes_to ON envelopes("to", status);
CREATE INDEX IF NOT EXISTS idx_envelopes_from ON envelopes("from", created_at);
CREATE INDEX IF NOT EXISTS idx_envelopes_status_deliver_at ON envelopes(status, deliver_at);
CREATE INDEX IF NOT EXISTS idx_cron_schedules_agent ON cron_schedules(agent_name, enabled);
CREATE INDEX IF NOT EXISTS idx_cron_schedules_pending_envelope ON cron_schedules(pending_envelope_id);
CREATE INDEX IF NOT EXISTS idx_agents_token ON agents(token);
CREATE INDEX IF NOT EXISTS idx_agent_bindings_agent ON agent_bindings(agent_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_bindings_agent_adapter_unique ON agent_bindings(agent_name, adapter_type);
CREATE INDEX IF NOT EXISTS idx_agent_bindings_adapter ON agent_bindings(adapter_type, adapter_token);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_name, started_at);
`;
