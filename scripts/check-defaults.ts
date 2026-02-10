import { SCHEMA_SQL } from "../src/daemon/db/schema.js";
import {
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_RUN_STATUS,
  DEFAULT_ENVELOPE_STATUS,
} from "../src/shared/defaults.js";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function assertIncludes(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`Defaults mismatch: ${label} (missing: ${needle})`);
  }
}

function main(): void {
  const normalized = normalizeSql(SCHEMA_SQL);

  assertIncludes(
    normalized,
    `provider TEXT DEFAULT '${DEFAULT_AGENT_PROVIDER}'`,
    "agents.provider"
  );
  assertIncludes(
    normalized,
    "reasoning_effort TEXT",
    "agents.reasoning_effort"
  );
  assertIncludes(
    normalized,
    `permission_level TEXT DEFAULT '${DEFAULT_AGENT_PERMISSION_LEVEL}'`,
    "agents.permission_level"
  );
  assertIncludes(
    normalized,
    `status TEXT DEFAULT '${DEFAULT_ENVELOPE_STATUS}'`,
    "envelopes.status"
  );
  assertIncludes(
    normalized,
    `status TEXT DEFAULT '${DEFAULT_AGENT_RUN_STATUS}'`,
    "agent_runs.status"
  );

  console.log("defaults:check ok");
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
}
