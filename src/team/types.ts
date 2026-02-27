export type TeamStatus = "active" | "archived";
export type TeamKind = "manual";

export interface Team {
  name: string;
  description?: string;
  status: TeamStatus;
  kind: TeamKind;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface TeamMember {
  teamName: string;
  agentName: string;
  source: "manual";
  createdAt: number;
}
