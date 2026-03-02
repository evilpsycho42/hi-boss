import { generateUUID } from "./uuid.js";

export function createNewAgentChatId(): string {
  return `agent-chat-${generateUUID()}`;
}

export function computeTeamChatId(teamName: string): string {
  return `team:${teamName}`;
}
