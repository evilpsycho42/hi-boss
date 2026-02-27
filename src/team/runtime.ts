import type { Agent } from "../agent/types.js";
import type { HiBossDatabase } from "../daemon/db/database.js";
import { getDefaultRuntimeWorkspace } from "../shared/defaults.js";
import { ensureTeamspaceDir, getTeamspaceDir } from "./teamspace.js";

export interface TeamPromptContext {
  name: string;
  members: string[];
  teamspaceDir: string;
}

function resolveTeamspaceDir(params: {
  hibossDir: string;
  teamName: string;
}): string {
  const ensured = ensureTeamspaceDir({
    hibossDir: params.hibossDir,
    teamName: params.teamName,
  });
  return ensured.ok ? ensured.dir : getTeamspaceDir(params.teamName, params.hibossDir);
}

export function resolveAgentWorkspace(params: {
  db: HiBossDatabase;
  hibossDir: string;
  agent: Agent;
}): string {
  const teams = params.db.listTeamsByAgentName(params.agent.name, { activeOnly: true });
  const primary = teams[0];
  if (!primary) {
    return params.agent.workspace ?? getDefaultRuntimeWorkspace();
  }
  return resolveTeamspaceDir({
    hibossDir: params.hibossDir,
    teamName: primary.name,
  });
}

export function buildAgentTeamPromptContext(params: {
  db: HiBossDatabase;
  hibossDir: string;
  agent: Agent;
}): TeamPromptContext[] {
  const teams = params.db.listTeamsByAgentName(params.agent.name, { activeOnly: true });
  return teams.map((team) => ({
    name: team.name,
    members: params.db.listTeamMemberAgentNames(team.name),
    teamspaceDir: resolveTeamspaceDir({
      hibossDir: params.hibossDir,
      teamName: team.name,
    }),
  }));
}
