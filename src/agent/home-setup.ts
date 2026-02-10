/**
 * Home directory setup for agents.
 *
 * Creates the agent directory with internal_space/ and SOUL.md.
 * Provider homes (codex_home/, claude_home/) are eliminated — both CLIs
 * use shared provider homes (forced defaults: ~/.claude, ~/.codex) with system
 * prompts injected via CLI flags.
 */

import * as fs from "fs";
import * as path from "path";
import { assertValidAgentName } from "../shared/validation.js";
import { getHiBossRootDir } from "../shared/hiboss-paths.js";
import { ensureAgentInternalSpaceLayout } from "../shared/internal-space.js";

/**
 * Get the default hi-boss directory path.
 */
export function getHiBossDir(): string {
  return getHiBossRootDir();
}

/**
 * Get the agent's directory path.
 */
export function getAgentDir(agentName: string, hibossDir?: string): string {
  assertValidAgentName(agentName);
  const baseDir = hibossDir ?? getHiBossDir();
  return path.join(baseDir, "agents", agentName);
}

export function getAgentInternalSpaceDir(agentName: string, hibossDir?: string): string {
  return path.join(getAgentDir(agentName, hibossDir), "internal_space");
}

/**
 * Set up the agent's home directory.
 *
 * Creates the agent directory with internal_space/ and SOUL.md.
 * No per-agent provider home directories are created.
 *
 * @param agentName - The agent's name
 * @param hibossDir - Optional custom hiboss directory (defaults to ~/hiboss; override via HIBOSS_DIR)
 */
export async function setupAgentHome(
  agentName: string,
  hibossDir?: string,
): Promise<void> {
  const baseDir = hibossDir ?? getHiBossDir();
  const agentDir = getAgentDir(agentName, hibossDir);

  // Create agent directory
  fs.mkdirSync(agentDir, { recursive: true });

  // Optional customization placeholders (created empty once; never overwritten).
  try {
    const soulPath = path.join(agentDir, "SOUL.md");
    if (!fs.existsSync(soulPath)) {
      fs.writeFileSync(soulPath, "", "utf8");
    }
  } catch {
    // Best-effort; do not fail setup on customization file issues.
  }

  // Ensure agent internal space exists (best-effort).
  const ensuredSpace = ensureAgentInternalSpaceLayout({ hibossDir: baseDir, agentName });
  if (!ensuredSpace.ok) {
    throw new Error(`Failed to initialize agent internal space: ${ensuredSpace.error}`);
  }
}

/**
 * Check if an agent's home directories exist.
 */
export function agentHomeExists(agentName: string, hibossDir?: string): boolean {
  const agentDir = getAgentDir(agentName, hibossDir);
  return fs.existsSync(agentDir);
}

/**
 * Remove an agent's home directories.
 */
export function removeAgentHome(agentName: string, hibossDir?: string): void {
  const agentDir = getAgentDir(agentName, hibossDir);
  if (fs.existsSync(agentDir)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}
