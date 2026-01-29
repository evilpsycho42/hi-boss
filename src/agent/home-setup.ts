/**
 * Home directory setup for agent providers.
 *
 * Creates isolated home directories for each agent with provider-specific configs:
 * - ~/.hiboss/agents/{name}/codex_home/  - CODEX_HOME with config.toml
 * - ~/.hiboss/agents/{name}/claude_home/ - CLAUDE_CONFIG_DIR with settings.json
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "node:url";
import { assertValidAgentName } from "../shared/validation.js";
import { getDefaultHiBossDir } from "../shared/defaults.js";

/**
 * Get the default hi-boss directory path.
 */
export function getHiBossDir(): string {
  return getDefaultHiBossDir();
}

/**
 * Get the agent's directory path.
 */
export function getAgentDir(agentName: string, hibossDir?: string): string {
  assertValidAgentName(agentName);
  const baseDir = hibossDir ?? getHiBossDir();
  return path.join(baseDir, "agents", agentName);
}

/**
 * Get the agent's codex home path.
 */
export function getCodexHomePath(agentName: string, hibossDir?: string): string {
  return path.join(getAgentDir(agentName, hibossDir), "codex_home");
}

/**
 * Get the agent's claude home path.
 */
export function getClaudeHomePath(agentName: string, hibossDir?: string): string {
  return path.join(getAgentDir(agentName, hibossDir), "claude_home");
}

/**
 * Get the appropriate home path based on provider.
 */
export function getAgentHomePath(
  agentName: string,
  provider: "claude" | "codex",
  hibossDir?: string
): string {
  return provider === "codex"
    ? getCodexHomePath(agentName, hibossDir)
    : getClaudeHomePath(agentName, hibossDir);
}

/**
 * Copy a file if it exists, creating parent directories as needed.
 */
function copyFileIfExists(src: string, dest: string): boolean {
  if (!fs.existsSync(src)) {
    return false;
  }

  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  fs.copyFileSync(src, dest);
  return true;
}

function findInternalSkillsDir(): string | null {
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = startDir;

  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "skills");
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // ignore
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function copyDirRecursive(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
      continue;
    }
    if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * Set up the agent's home directories with provider configs.
 *
 * Creates both codex_home and claude_home for the agent and copies
 * the base configs from the user's home directory (if they exist).
 *
 * @param agentName - The agent's name
 * @param hibossDir - Optional custom hiboss directory (defaults to ~/.hiboss)
 */
export async function setupAgentHome(
  agentName: string,
  hibossDir?: string
): Promise<void> {
  const codexHome = getCodexHomePath(agentName, hibossDir);
  const claudeHome = getClaudeHomePath(agentName, hibossDir);

  // Create directories
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });

  // Copy Codex config (if exists)
  const userCodexConfig = path.join(os.homedir(), ".codex", "config.toml");
  const agentCodexConfig = path.join(codexHome, "config.toml");
  copyFileIfExists(userCodexConfig, agentCodexConfig);

  // Copy built-in skills for Codex agents (if present in the package workspace)
  const internalSkillsDir = findInternalSkillsDir();
  if (internalSkillsDir) {
    const codexSkillsDir = path.join(codexHome, "skills");
    const hibossMem = path.join(internalSkillsDir, "hiboss-mem");
    if (fs.existsSync(hibossMem)) {
      copyDirRecursive(hibossMem, path.join(codexSkillsDir, "hiboss-mem"));
    }
  }

  // Copy Claude configs (if exist)
  const userClaudeDir = path.join(os.homedir(), ".claude");
  const claudeSettings = path.join(userClaudeDir, "settings.json");
  const claudeJson = path.join(userClaudeDir, ".claude.json");

  copyFileIfExists(claudeSettings, path.join(claudeHome, "settings.json"));
  copyFileIfExists(claudeJson, path.join(claudeHome, ".claude.json"));
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
