/**
 * Home directory setup for agent providers.
 *
 * Creates isolated home directories for each agent with provider-specific configs:
 * - ~/hiboss/agents/{name}/codex_home/  - CODEX_HOME with config.toml
 * - ~/hiboss/agents/{name}/claude_home/ - CLAUDE_CONFIG_DIR with settings.json
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { assertValidAgentName } from "../shared/validation.js";
import { getHiBossRootDir } from "../shared/hiboss-paths.js";
import { ensureAgentInternalSpaceLayout } from "../shared/internal-space.js";
import { getProviderStateDir } from "../shared/skills-paths.js";

export interface SetupAgentHomeOptions {
  provider?: "claude" | "codex";
  providerSourceHome?: string;
}

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

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function resolveProviderSourceHome(options: SetupAgentHomeOptions): string | undefined {
  if (!options.provider && !options.providerSourceHome) {
    return undefined;
  }

  const provider = options.provider;
  if (!provider) {
    return undefined;
  }

  const fallback = provider === "codex"
    ? path.join(os.homedir(), ".codex")
    : path.join(os.homedir(), ".claude");

  const raw = options.providerSourceHome?.trim();
  const expanded = expandTilde(raw && raw.length > 0 ? raw : fallback);
  if (!path.isAbsolute(expanded)) {
    throw new Error(`Invalid provider-source-home (must be an absolute path): ${expanded}`);
  }
  return expanded;
}

/**
 * Set up the agent's home directories with provider configs.
 *
 * Creates both codex_home and claude_home for the agent and imports
 * provider configs into the selected provider home.
 *
 * When `options.provider` is omitted, this function falls back to the legacy
 * behavior of importing configs for both providers from their default homes.
 *
 * @param agentName - The agent's name
 * @param hibossDir - Optional custom hiboss directory (defaults to ~/hiboss; override via HIBOSS_DIR)
 * @param options - Optional provider import settings
 */
export async function setupAgentHome(
  agentName: string,
  hibossDir?: string,
  options: SetupAgentHomeOptions = {}
): Promise<void> {
  const baseDir = hibossDir ?? getHiBossDir();
  const agentDir = getAgentDir(agentName, hibossDir);
  const codexHome = getCodexHomePath(agentName, hibossDir);
  const claudeHome = getClaudeHomePath(agentName, hibossDir);

  // Create directories
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(path.join(codexHome, "skills"), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, "skills"), { recursive: true });
  fs.mkdirSync(getProviderStateDir(codexHome), { recursive: true });
  fs.mkdirSync(getProviderStateDir(claudeHome), { recursive: true });

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

  const sourceHome = resolveProviderSourceHome(options);

  const provider = options.provider;
  if (provider === "codex" || provider === undefined) {
    // Copy Codex configs (if exist)
    const userCodexDir = sourceHome && provider === "codex"
      ? sourceHome
      : path.join(os.homedir(), ".codex");
    const userCodexConfig = path.join(userCodexDir, "config.toml");
    const userCodexAuth = path.join(userCodexDir, "auth.json");

    copyFileIfExists(userCodexConfig, path.join(codexHome, "config.toml"));
    copyFileIfExists(userCodexAuth, path.join(codexHome, "auth.json"));
  }

  if (provider === "claude" || provider === undefined) {
    // Copy Claude configs (if exist)
    const userClaudeDir = sourceHome && provider === "claude"
      ? sourceHome
      : path.join(os.homedir(), ".claude");
    const claudeSettings = path.join(userClaudeDir, "settings.json");
    const claudeJson = path.join(userClaudeDir, ".claude.json");

    copyFileIfExists(claudeSettings, path.join(claudeHome, "settings.json"));
    copyFileIfExists(claudeJson, path.join(claudeHome, ".claude.json"));
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
