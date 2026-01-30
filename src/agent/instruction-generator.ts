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
import { getCodexHomePath, getClaudeHomePath } from "./home-setup.js";
import { nowLocalIso } from "../shared/time.js";
import { ensureAgentMemoryLayout, readAgentMemorySnapshot } from "../shared/agent-memory.js";

/**
 * Context for generating system instructions.
 */
export interface InstructionContext {
  agent: Agent;
  agentToken: string;
  bindings?: AgentBinding[];
  additionalContext?: string;
  hibossDir?: string;
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
    hibossDir: ctx.hibossDir,
    boss,
  });

  // Inject file-based memory snapshot for this agent (best-effort; never prints token).
  const hibossDir = ctx.hibossDir ?? (promptContext.hiboss as Record<string, unknown>).dir as string;
  const memoryContext = promptContext.memory as Record<string, unknown>;
  const ensured = ensureAgentMemoryLayout({ hibossDir, agentName: agent.name });
  if (!ensured.ok) {
    memoryContext.longterm = "";
    memoryContext.longtermFence = "```";
    memoryContext.shortterm = "";
    memoryContext.shorttermFence = "```";
    memoryContext.error = ensured.error;
  } else {
    const snapshot = readAgentMemorySnapshot({ hibossDir, agentName: agent.name });
    if (snapshot.ok) {
      memoryContext.longterm = snapshot.longterm;
      memoryContext.longtermFence = chooseFence(snapshot.longterm);
      memoryContext.shortterm = snapshot.shortterm;
      memoryContext.shorttermFence = chooseFence(snapshot.shortterm);
      memoryContext.error = "";
    } else {
      memoryContext.longterm = "";
      memoryContext.longtermFence = "```";
      memoryContext.shortterm = "";
      memoryContext.shorttermFence = "```";
      memoryContext.error = snapshot.error;
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
 * @param options - Optional settings (hibossDir, debug)
 */
export async function writeInstructionFiles(
  agentName: string,
  instructions: string,
  options?: { hibossDir?: string; debug?: boolean }
): Promise<void> {
  const { hibossDir, debug } = options ?? {};

  // Log the content being written (only in debug mode)
  if (debug) {
    console.log(`[${nowLocalIso()}] [InstructionGenerator] Writing AGENTS.md / CLAUDE.md for ${agentName}:`);
    console.log("─".repeat(60));
    console.log(instructions);
    console.log("─".repeat(60));
  }

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
