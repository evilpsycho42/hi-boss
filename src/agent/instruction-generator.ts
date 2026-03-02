/**
 * Instruction generator for agent system prompts.
 *
 * Generates system instructions as a string to be passed inline
 * to provider CLIs via --append-system-prompt (Claude) or
 * -c developer_instructions=... (Codex).
 */

import type { Agent } from "./types.js";
import type { AgentBinding } from "../daemon/db/database.js";
import { renderPrompt } from "../shared/prompt-renderer.js";
import { buildSystemPromptContext } from "../shared/prompt-context.js";
import {
  ensureAgentInternalSpaceLayout,
  readAgentInternalDailyMemorySnapshot,
  readAgentInternalMemorySnapshot,
  readAgentInternalSessionHandoffSnapshot,
} from "../shared/internal-space.js";

/**
 * Context for generating system instructions.
 */
export interface InstructionContext {
  agent: Agent;
  agentToken: string;
  bindings?: AgentBinding[];
  workspaceDir?: string;
  teams?: Array<{
    name: string;
    members: string[];
    teamspaceDir: string;
  }>;
  additionalContext?: string;
  hibossDir?: string;
  bossTimezone?: string;
  boss?: {
    name?: string;
    adapterIds?: Record<string, string>;
  };
  sessionHandoffConfig?: {
    recentDays: number;
    perSessionMaxChars: number;
  };
}

function chooseFence(text: string): string {
  let fence = "```";
  while (text.includes(fence)) {
    fence += "`";
  }
  return fence;
}

/**
 * Generate system instructions for an agent.
 *
 * Returns a string suitable for passing inline to CLI flags:
 * - Claude: --append-system-prompt
 * - Codex: -c developer_instructions=...
 *
 * @param ctx - Instruction context with agent info and bindings
 * @returns Generated instruction content
 */
export function generateSystemInstructions(ctx: InstructionContext): string {
  const { agent, agentToken, bindings, additionalContext, boss } = ctx;

  const promptContext = buildSystemPromptContext({
    agent,
    agentToken,
    bindings: bindings ?? [],
    workspaceDir: ctx.workspaceDir,
    teams: ctx.teams ?? [],
    time: { bossTimezone: ctx.bossTimezone },
    hibossDir: ctx.hibossDir,
    boss,
  });

  // Inject internal space MEMORY.md snapshot for this agent (best-effort; never prints token).
  const hibossDir = ctx.hibossDir ?? (promptContext.hiboss as Record<string, unknown>).dir as string;
  const spaceContext = promptContext.internalSpace as Record<string, unknown>;
  const ensured = ensureAgentInternalSpaceLayout({ hibossDir, agentName: agent.name });
  if (!ensured.ok) {
    spaceContext.note = "";
    spaceContext.noteFence = "```";
    spaceContext.error = ensured.error;
    spaceContext.daily = "";
    spaceContext.dailyFence = "```";
    spaceContext.dailyError = ensured.error;
    spaceContext.sessionHandoffs = "";
    spaceContext.sessionHandoffsFence = "```";
    spaceContext.sessionHandoffsError = ensured.error;
  } else {
    const snapshot = readAgentInternalMemorySnapshot({ hibossDir, agentName: agent.name });
    if (snapshot.ok) {
      spaceContext.note = snapshot.note;
      spaceContext.noteFence = chooseFence(snapshot.note);
      spaceContext.error = "";
    } else {
      spaceContext.note = "";
      spaceContext.noteFence = "```";
      spaceContext.error = snapshot.error;
    }

    const dailySnapshot = readAgentInternalDailyMemorySnapshot({ hibossDir, agentName: agent.name });
    if (dailySnapshot.ok) {
      spaceContext.daily = dailySnapshot.note;
      spaceContext.dailyFence = chooseFence(dailySnapshot.note);
      spaceContext.dailyError = "";
    } else {
      spaceContext.daily = "";
      spaceContext.dailyFence = "```";
      spaceContext.dailyError = dailySnapshot.error;
    }

    const sessionHandoffSnapshot = readAgentInternalSessionHandoffSnapshot({
      hibossDir,
      agentName: agent.name,
      recentDays: ctx.sessionHandoffConfig?.recentDays,
      perSessionMaxChars: ctx.sessionHandoffConfig?.perSessionMaxChars,
    });
    spaceContext.sessionHandoffRecentDays = ctx.sessionHandoffConfig?.recentDays ?? spaceContext.sessionHandoffRecentDays;
    spaceContext.sessionHandoffPerSessionMaxChars =
      ctx.sessionHandoffConfig?.perSessionMaxChars ?? spaceContext.sessionHandoffPerSessionMaxChars;
    if (sessionHandoffSnapshot.ok) {
      spaceContext.sessionHandoffs = sessionHandoffSnapshot.note;
      spaceContext.sessionHandoffsFence = chooseFence(sessionHandoffSnapshot.note);
      spaceContext.sessionHandoffsError = "";
    } else {
      spaceContext.sessionHandoffs = "";
      spaceContext.sessionHandoffsFence = "```";
      spaceContext.sessionHandoffsError = sessionHandoffSnapshot.error;
    }
  }

  (promptContext.hiboss as Record<string, unknown>).additionalContext =
    additionalContext ?? "";

  return renderPrompt({
    surface: "system",
    template: "system/base.md",
    context: promptContext,
  });
}
