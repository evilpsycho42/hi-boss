/**
 * SQLite schema definitions for Hi-Boss.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

	CREATE TABLE IF NOT EXISTS agents (
	  name TEXT PRIMARY KEY,       -- unique identifier (alphanumeric, hyphens)
	  token TEXT UNIQUE NOT NULL,  -- agent token (short identifier; stored as plaintext)
	  description TEXT,
	  workspace TEXT,
	  provider TEXT DEFAULT 'claude',
  model TEXT,
  reasoning_effort TEXT DEFAULT 'medium',
  auto_level TEXT DEFAULT 'high',
  permission_level TEXT DEFAULT 'standard',
  session_policy TEXT,           -- JSON blob for SessionPolicyConfig
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  from_boss INTEGER DEFAULT 0,
  content_text TEXT,
  content_attachments TEXT,
  deliver_at TEXT,            -- ISO 8601 UTC timestamp (not-before delivery)
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS agent_bindings (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,    -- references agents(name)
  adapter_type TEXT NOT NULL,
  adapter_token TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(adapter_type, adapter_token),
  FOREIGN KEY (agent_name) REFERENCES agents(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  envelope_ids TEXT,           -- JSON array of processed envelope IDs
  final_response TEXT,         -- stored for auditing
  status TEXT DEFAULT 'running', -- running, completed, failed
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_envelopes_to ON envelopes("to", status);
CREATE INDEX IF NOT EXISTS idx_envelopes_from ON envelopes("from", created_at);
CREATE INDEX IF NOT EXISTS idx_envelopes_status_deliver_at ON envelopes(status, deliver_at);
CREATE INDEX IF NOT EXISTS idx_agents_token ON agents(token);
CREATE INDEX IF NOT EXISTS idx_agent_bindings_agent ON agent_bindings(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_bindings_adapter ON agent_bindings(adapter_type, adapter_token);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_name, started_at);
`;
