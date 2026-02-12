export const AGENT_ROLES = ["speaker", "leader"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isAgentRole(value: unknown): value is AgentRole {
  return value === "speaker" || value === "leader";
}

export function parseAgentRoleFromMetadata(metadata: unknown): AgentRole | undefined {
  if (!isObject(metadata)) return undefined;
  const role = metadata.role;
  return isAgentRole(role) ? role : undefined;
}

export function inferAgentRoleFromBindingCount(bindingCount: number): AgentRole {
  const count = Number.isFinite(bindingCount) ? Math.max(0, Math.trunc(bindingCount)) : 0;
  return count > 0 ? "speaker" : "leader";
}

/**
 * Resolve an agent role for compatibility code paths.
 *
 * Priority:
 * 1. `metadata.role` when present
 * 2. Legacy inference from binding count (bound => speaker, unbound => leader)
 */
export function resolveAgentRole(params: {
  metadata?: Record<string, unknown>;
  bindingCount?: number;
}): AgentRole {
  const explicit = parseAgentRoleFromMetadata(params.metadata);
  if (explicit) return explicit;
  return inferAgentRoleFromBindingCount(params.bindingCount ?? 0);
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
  speakerCount: number;
  leaderCount: number;
  missingSpeaker: boolean;
  missingLeader: boolean;
} {
  const bindingCountByAgent = new Map<string, number>();
  for (const binding of params.bindings) {
    const current = bindingCountByAgent.get(binding.agentName) ?? 0;
    bindingCountByAgent.set(binding.agentName, current + 1);
  }

  let speakerCount = 0;
  let leaderCount = 0;
  for (const agent of params.agents) {
    const role = resolveAgentRole({
      metadata: agent.metadata,
      bindingCount: bindingCountByAgent.get(agent.name) ?? 0,
    });
    if (role === "speaker") speakerCount++;
    if (role === "leader") leaderCount++;
  }

  return {
    speakerCount,
    leaderCount,
    missingSpeaker: speakerCount < 1,
    missingLeader: leaderCount < 1,
  };
}

export function buildMissingAgentRolesGuidance(params: {
  missingSpeaker: boolean;
  missingLeader: boolean;
}): string {
  void params;
  const lines: string[] = [
    "Daemon start blocked: setup is incomplete.",
    "Repair with setup config export/apply:",
    "1. hiboss setup export",
    "2. edit the exported JSON config",
    "3. hiboss setup --config-file <path> --token <boss-token> --dry-run",
    "4. hiboss setup --config-file <path> --token <boss-token>",
  ];
  return lines.join("\n");
}
