export const AGENT_NAME_REGEX = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export const AGENT_NAME_ERROR_MESSAGE =
  "Agent name must be alphanumeric with hyphens";

export const TEAM_NAME_REGEX = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export const TEAM_NAME_ERROR_MESSAGE =
  "Team name must be alphanumeric with hyphens";

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_REGEX.test(name);
}

export function assertValidAgentName(name: string): void {
  if (!isValidAgentName(name)) {
    throw new Error(AGENT_NAME_ERROR_MESSAGE);
  }
}

export function isValidTeamName(name: string): boolean {
  return TEAM_NAME_REGEX.test(name);
}

export function assertValidTeamName(name: string): void {
  if (!isValidTeamName(name)) {
    throw new Error(TEAM_NAME_ERROR_MESSAGE);
  }
}
