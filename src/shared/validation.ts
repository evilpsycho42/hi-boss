export const AGENT_NAME_REGEX = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export const AGENT_NAME_ERROR_MESSAGE =
  "Agent name must be alphanumeric with hyphens";

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_REGEX.test(name);
}

export function assertValidAgentName(name: string): void {
  if (!isValidAgentName(name)) {
    throw new Error(AGENT_NAME_ERROR_MESSAGE);
  }
}
