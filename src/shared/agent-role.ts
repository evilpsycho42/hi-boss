export const AGENT_ROLES = ["leader", "worker"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isAgentRole(value: unknown): value is AgentRole {
  return value === "leader" || value === "worker";
}

export function parseAgentRoleFromMetadata(metadata: unknown): AgentRole | undefined {
  if (!isObject(metadata)) return undefined;
  const role = metadata.role;
  return isAgentRole(role) ? role : undefined;
}

export function inferAgentRoleFromBindingCount(bindingCount: number): AgentRole {
  void bindingCount;
  return "leader";
}

/**
 * Resolve an agent role for compatibility code paths.
 *
 * Priority:
 * 1. `metadata.role` when present
 * 2. Default to `leader`
 */
export function resolveAgentRole(params: {
  metadata?: Record<string, unknown>;
  bindingCount?: number;
}): AgentRole {
  const explicit = parseAgentRoleFromMetadata(params.metadata);
  if (explicit) return explicit;
  void params.bindingCount;
  return "leader";
}

export function withAgentRoleMetadata(params: {
  metadata?: Record<string, unknown>;
  role?: AgentRole;
  stripSessionHandle?: boolean;
}): Record<string, unknown> | undefined {
  const base = params.metadata ? { ...params.metadata } : {};
  if (params.stripSessionHandle) {
    delete base.sessionHandle;
  }
  delete base.role;
  if (params.role) {
    base.role = params.role;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

export function getAgentRoleCoverage(params: {
  agents: Array<{ name: string; metadata?: Record<string, unknown> }>;
  bindings: Array<{ agentName: string }>;
}): {
  leaderCount: number;
  workerCount: number;
  missingLeader: boolean;
} {
  const bindingCountByAgent = new Map<string, number>();
  for (const binding of params.bindings) {
    const current = bindingCountByAgent.get(binding.agentName) ?? 0;
    bindingCountByAgent.set(binding.agentName, current + 1);
  }

  let leaderCount = 0;
  let workerCount = 0;
  for (const agent of params.agents) {
    const role = resolveAgentRole({
      metadata: agent.metadata,
      bindingCount: bindingCountByAgent.get(agent.name) ?? 0,
    });
    if (role === "leader") leaderCount++;
    if (role === "worker") workerCount++;
  }

  return {
    leaderCount,
    workerCount,
    missingLeader: leaderCount < 1,
  };
}

export function buildMissingAgentRolesGuidance(params: {
  missingLeader: boolean;
}): string {
  void params;
  const lines: string[] = [
    "Daemon start blocked: setup is incomplete.",
    "Repair by editing settings.json:",
    "1. open ~/hiboss/settings.json",
    "2. ensure at least one leader is present",
    "3. restart daemon: hiboss daemon start",
  ];
  return lines.join("\n");
}
