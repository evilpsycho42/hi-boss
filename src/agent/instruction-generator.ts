/**
 * Instruction generator for agent system prompts.
 *
 * Generates AGENTS.md and CLAUDE.md files for agent sessions.
 */

import * as fs from "fs";
import * as path from "path";
import type { Agent } from "./types.js";
import type { AgentBinding } from "../daemon/db/database.js";
import { renderPrompt } from "../shared/prompt-renderer.js";
import { buildSystemPromptContext } from "../shared/prompt-context.js";
import { formatAgentAddress } from "../adapters/types.js";
import { getCodexHomePath, getClaudeHomePath } from "./home-setup.js";
import { ensureAgentInternalSpaceLayout, readAgentInternalNoteSnapshot } from "../shared/internal-space.js";

/**
 * Context for generating system instructions.
 */
export interface InstructionContext {
  agent: Agent;
  agentToken: string;
  bindings?: AgentBinding[];
  additionalContext?: string;
  hibossDir?: string;
  bossTimezone?: string;
  boss?: {
    name?: string;
    adapterIds?: Record<string, string>;
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
 * Format bindings into a readable string.
 */
/**
 * Generate system instructions for an agent.
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
    time: { bossTimezone: ctx.bossTimezone },
    hibossDir: ctx.hibossDir,
    boss,
  });

  // Inject internal space Note.md snapshot for this agent (best-effort; never prints token).
  const hibossDir = ctx.hibossDir ?? (promptContext.hiboss as Record<string, unknown>).dir as string;
  const spaceContext = promptContext.internalSpace as Record<string, unknown>;
  const ensured = ensureAgentInternalSpaceLayout({ hibossDir, agentName: agent.name });
  if (!ensured.ok) {
    spaceContext.note = "";
    spaceContext.noteFence = "```";
    spaceContext.error = ensured.error;
  } else {
    const snapshot = readAgentInternalNoteSnapshot({ hibossDir, agentName: agent.name });
    if (snapshot.ok) {
      spaceContext.note = snapshot.note;
      spaceContext.noteFence = chooseFence(snapshot.note);
      spaceContext.error = "";
    } else {
      spaceContext.note = "";
      spaceContext.noteFence = "```";
      spaceContext.error = snapshot.error;
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

/**
 * Write instruction files to agent's home directories.
 *
 * Writes AGENTS.md to codex_home and CLAUDE.md to claude_home.
 * Only called when creating a NEW session (instructions persist in session).
 *
 * @param agentName - The agent's name
 * @param instructions - The instruction content
 * @param options - Optional settings (hibossDir)
 */
export async function writeInstructionFiles(
  agentName: string,
  instructions: string,
  options?: { hibossDir?: string }
): Promise<void> {
  const { hibossDir } = options ?? {};

  // Write to codex_home/AGENTS.md
  const codexHome = getCodexHomePath(agentName, hibossDir);
  const agentsMdPath = path.join(codexHome, "AGENTS.md");

  // Ensure directory exists
  if (!fs.existsSync(codexHome)) {
    fs.mkdirSync(codexHome, { recursive: true });
  }
  fs.writeFileSync(agentsMdPath, instructions, "utf-8");

  // Write to claude_home/CLAUDE.md
  const claudeHome = getClaudeHomePath(agentName, hibossDir);
  const claudeMdPath = path.join(claudeHome, "CLAUDE.md");

  // Ensure directory exists
  if (!fs.existsSync(claudeHome)) {
    fs.mkdirSync(claudeHome, { recursive: true });
  }
  fs.writeFileSync(claudeMdPath, instructions, "utf-8");
}

/**
 * Read existing instruction file content.
 */
export function readInstructionFile(
  agentName: string,
  provider: "claude" | "codex",
  hibossDir?: string
): string | null {
  const homePath = provider === "codex"
    ? getCodexHomePath(agentName, hibossDir)
    : getClaudeHomePath(agentName, hibossDir);

  const filename = provider === "codex" ? "AGENTS.md" : "CLAUDE.md";
  const filePath = path.join(homePath, filename);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath, "utf-8");
}
