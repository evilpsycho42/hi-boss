import { resolveAgentRole, type AgentRole } from "./agent-role.js";

export interface AgentBindingLike {
  agentName: string;
  adapterType: string;
  adapterToken: string;
}

export interface AgentLike {
  name: string;
  metadata?: Record<string, unknown>;
}

export interface DuplicateSpeakerBinding {
  adapterType: string;
  adapterToken: string;
  speakers: string[];
}

export interface SpeakerBindingIntegrity {
  speakerWithoutBindings: string[];
  duplicateSpeakerBindings: DuplicateSpeakerBinding[];
}

export interface SpeakerBindingIntegrityView {
  speakerWithoutBindings: string[];
  duplicateSpeakerBindings: Array<{
    adapterType: string;
    adapterTokenRedacted: string;
    speakers: string[];
  }>;
}

function buildBindingCountByAgent(bindings: AgentBindingLike[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const binding of bindings) {
    counts.set(binding.agentName, (counts.get(binding.agentName) ?? 0) + 1);
  }
  return counts;
}

function resolveAgentRoleWithCount(
  agent: AgentLike,
  bindingCountByAgent: Map<string, number>
): AgentRole {
  return resolveAgentRole({
    metadata: agent.metadata,
    bindingCount: bindingCountByAgent.get(agent.name) ?? 0,
  });
}

export function getSpeakerBindingIntegrity(params: {
  agents: AgentLike[];
  bindings: AgentBindingLike[];
}): SpeakerBindingIntegrity {
  const bindingCountByAgent = buildBindingCountByAgent(params.bindings);

  const speakers = params.agents
    .filter((agent) => resolveAgentRoleWithCount(agent, bindingCountByAgent) === "speaker")
    .map((agent) => agent.name);

  const speakerSet = new Set(speakers);

  const speakerWithoutBindings = speakers
    .filter((name) => (bindingCountByAgent.get(name) ?? 0) < 1)
    .sort((a, b) => a.localeCompare(b));

  const speakersByAdapter = new Map<string, { adapterType: string; adapterToken: string; speakers: Set<string> }>();
  for (const binding of params.bindings) {
    if (!speakerSet.has(binding.agentName)) continue;
    const key = `${binding.adapterType}\u0000${binding.adapterToken}`;
    const current = speakersByAdapter.get(key);
    if (current) {
      current.speakers.add(binding.agentName);
      continue;
    }
    speakersByAdapter.set(key, {
      adapterType: binding.adapterType,
      adapterToken: binding.adapterToken,
      speakers: new Set([binding.agentName]),
    });
  }

  const duplicateSpeakerBindings = Array.from(speakersByAdapter.values())
    .filter((entry) => entry.speakers.size > 1)
    .map((entry) => ({
      adapterType: entry.adapterType,
      adapterToken: entry.adapterToken,
      speakers: Array.from(entry.speakers).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => {
      if (a.adapterType !== b.adapterType) return a.adapterType.localeCompare(b.adapterType);
      return a.adapterToken.localeCompare(b.adapterToken);
    });

  return {
    speakerWithoutBindings,
    duplicateSpeakerBindings,
  };
}

function redactAdapterToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return "(empty)";
  if (trimmed.length <= 8) return `${trimmed[0]}***`;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-2)}`;
}

export function toSpeakerBindingIntegrityView(
  integrity: SpeakerBindingIntegrity
): SpeakerBindingIntegrityView {
  return {
    speakerWithoutBindings: [...integrity.speakerWithoutBindings],
    duplicateSpeakerBindings: integrity.duplicateSpeakerBindings.map((entry) => ({
      adapterType: entry.adapterType,
      adapterTokenRedacted: redactAdapterToken(entry.adapterToken),
      speakers: [...entry.speakers],
    })),
  };
}

export function hasSpeakerBindingIntegrityViolations(integrity: SpeakerBindingIntegrity): boolean {
  return integrity.speakerWithoutBindings.length > 0 || integrity.duplicateSpeakerBindings.length > 0;
}

