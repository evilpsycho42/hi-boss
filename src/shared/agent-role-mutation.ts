/**
 * Agent role mutation validation.
 *
 * Utilities for predicting role changes and validating that mutations
 * will not violate the role invariant (minimum 1 speaker + 1 leader).
 */

import type { Agent } from "../agent/types.js";
import { resolveAgentRole, getAgentRoleCoverage, type AgentRole } from "./agent-role.js";

export interface RoleMutationPrediction {
  /** Role before mutation */
  before: AgentRole;
  /** Role after mutation */
  after: AgentRole;
  /** Would this mutation break the invariant? */
  breaking: boolean;
  /** If breaking, which role would be missing */
  missingRole?: "speaker" | "leader";
}

/**
 * Predict role change from binding mutation.
 *
 * **Binding-count transience**: Agents without explicit roles flip role
 * based on binding count:
 * - bindingCount > 0 → "speaker" (bound to channel)
 * - bindingCount == 0 → "leader" (free agent, handles coordination)
 *
 * Agents with explicit `metadata.role` do NOT flip.
 */
export function predictRoleAfterBindingMutation(params: {
  agent: Agent;
  bindingCountDelta: number; // -1 for unbind, +1 for bind
  allAgents: Agent[];
  allBindings: Array<{ agentName: string }>;
}): RoleMutationPrediction {
  const { agent, bindingCountDelta, allAgents, allBindings } = params;

  // Calculate current binding count
  const currentBindingCount = allBindings.filter((b) => b.agentName === agent.name).length;
  const newBindingCount = Math.max(0, currentBindingCount + bindingCountDelta);

  // Resolve roles before and after
  const before = resolveAgentRole({
    metadata: agent.metadata,
    bindingCount: currentBindingCount,
  });

  const after = resolveAgentRole({
    metadata: agent.metadata,
    bindingCount: newBindingCount,
  });

  // Check if mutation would break invariant
  const bindingsAfter = allBindings.map((b) =>
    b.agentName === agent.name ? { agentName: b.agentName } : b
  );

  // Remove bindings for this agent and re-add with new count
  const bindingsWithoutThisAgent = allBindings.filter((b) => b.agentName !== agent.name);
  const newBindings = [
    ...bindingsWithoutThisAgent,
    ...Array.from({ length: newBindingCount }, () => ({ agentName: agent.name })),
  ];

  const coverage = getAgentRoleCoverage({
    agents: allAgents,
    bindings: newBindings,
  });

  const breaking = coverage.missingSpeaker || coverage.missingLeader;
  const missingRole = coverage.missingSpeaker ? ("speaker" as const) : coverage.missingLeader ? ("leader" as const) : undefined;

  return {
    before,
    after,
    breaking,
    missingRole,
  };
}

/**
 * Predict role change from explicit role mutation.
 *
 * When admin sets `--role`, explicit role in metadata is updated.
 */
export function predictRoleAfterExplicitMutation(params: {
  agent: Agent;
  newRole: AgentRole;
  allAgents: Agent[];
  allBindings: Array<{ agentName: string }>;
}): RoleMutationPrediction {
  const { agent, newRole, allAgents, allBindings } = params;

  const before = resolveAgentRole({
    metadata: agent.metadata,
    bindingCount: allBindings.filter((b) => b.agentName === agent.name).length,
  });

  // After explicit role set, agent will always be that role
  const after = newRole;

  // Check invariant with new role
  const agentsWithNewRole = allAgents.map((a) => (a.name === agent.name ? { ...a, metadata: { ...a.metadata, role: newRole } } : a));

  const coverage = getAgentRoleCoverage({
    agents: agentsWithNewRole,
    bindings: allBindings,
  });

  const breaking = coverage.missingSpeaker || coverage.missingLeader;
  const missingRole = coverage.missingSpeaker ? ("speaker" as const) : coverage.missingLeader ? ("leader" as const) : undefined;

  return {
    before,
    after,
    breaking,
    missingRole,
  };
}

/**
 * Predict role change from agent deletion.
 *
 * Deleting an agent removes all its bindings and roles.
 */
export function predictRoleAfterDeletion(params: {
  agentName: string;
  allAgents: Agent[];
  allBindings: Array<{ agentName: string }>;
}): {
  breaking: boolean;
  missingRole?: "speaker" | "leader";
} {
  const { agentName, allAgents, allBindings } = params;

  // After deletion, agent is gone
  const agentsAfterDelete = allAgents.filter((a) => a.name !== agentName);
  const bindingsAfterDelete = allBindings.filter((b) => b.agentName !== agentName);

  const coverage = getAgentRoleCoverage({
    agents: agentsAfterDelete,
    bindings: bindingsAfterDelete,
  });

  const breaking = coverage.missingSpeaker || coverage.missingLeader;
  const missingRole = coverage.missingSpeaker ? ("speaker" as const) : coverage.missingLeader ? ("leader" as const) : undefined;

  return {
    breaking,
    missingRole,
  };
}

/**
 * Build error message for invariant violation.
 */
export function buildMutationInvariantViolationMessage(params: {
  operation: "unbind" | "delete" | "set-role";
  agentName: string;
  prediction: RoleMutationPrediction | { breaking: boolean; missingRole?: "speaker" | "leader" };
}): string {
  const { operation, agentName, prediction } = params;
  const missingRole = "missingRole" in prediction ? prediction.missingRole : undefined;

  if (!("before" in prediction)) {
    // Deletion prediction
    return (
      `Cannot ${operation} agent '${agentName}': would leave zero ${missingRole}s.\n` +
      `Required invariant: at least 1 speaker and 1 leader.\n` +
      `Create another ${missingRole} before removing this agent.`
    );
  }

  const { before, after } = prediction;

  if (operation === "unbind") {
    return (
      `Cannot unbind agent '${agentName}': would break role invariant.\n` +
      `Role would change: ${before} → ${after}\n` +
      `Required invariant: at least 1 speaker and 1 leader.\n` +
      `Currently, '${agentName}' is the only ${before}.\n` +
      `Create another ${before} before unbinding.`
    );
  }

  if (operation === "set-role") {
    return (
      `Cannot set role on agent '${agentName}' to '${after}': would break invariant.\n` +
      `This agent is the only ${before}.\n` +
      `Create another ${before} or reconsider the role change.`
    );
  }

  return `Mutation would violate role invariant.`;
}
