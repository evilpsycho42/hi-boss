export function computeDmChatId(agentA: string, agentB: string): string {
  const sorted = [agentA, agentB].sort((a, b) => a.localeCompare(b));
  return `agent-dm:${sorted[0]}:${sorted[1]}`;
}

export function computeTeamChatId(teamName: string): string {
  return `team:${teamName}`;
}
