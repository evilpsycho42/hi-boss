import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { getDefaultConfig } from "../../daemon/daemon.js";
import { getSettingsPath, readSettingsFile } from "../../shared/settings-io.js";

export type ManagedDaemonAction = "start" | "stop" | "status";
type DeploymentMode = "docker" | "pm2";

interface DeploymentConfig {
  mode: DeploymentMode;
  outputDir: string;
}

interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoteForCmd(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function runCommand(command: string, args: string[], options: RunCommandOptions = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  if (!options.quiet) {
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}${
        stderr ? `: ${stderr}` : ""
      }`
    );
  }

  return stdout;
}

function readDeploymentConfig(): DeploymentConfig | null {
  const daemonConfig = getDefaultConfig();
  const settingsPath = getSettingsPath(daemonConfig.dataDir);
  if (!fs.existsSync(settingsPath)) return null;

  const rawText = fs.readFileSync(settingsPath, "utf8");
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch {
    throw new Error(`Invalid settings JSON at ${settingsPath}`);
  }

  if (!isObject(rawJson)) return null;
  const runtimeRaw = rawJson.runtime;
  if (!isObject(runtimeRaw)) return null;
  const deploymentRaw = runtimeRaw.deployment;
  if (deploymentRaw === undefined || deploymentRaw === null) return null;
  if (!isObject(deploymentRaw)) {
    throw new Error("Invalid settings.runtime.deployment: expected an object");
  }

  const mode = typeof deploymentRaw.mode === "string" ? deploymentRaw.mode.trim().toLowerCase() : "";
  if (mode !== "docker" && mode !== "pm2") {
    throw new Error("Invalid settings.runtime.deployment.mode: expected 'docker' or 'pm2'");
  }

  const outputDirRaw =
    typeof deploymentRaw["output-dir"] === "string"
      ? deploymentRaw["output-dir"]
      : typeof deploymentRaw.outputDir === "string"
        ? deploymentRaw.outputDir
        : "";
  const outputDir = outputDirRaw.trim();
  if (!outputDir) {
    throw new Error("Invalid settings.runtime.deployment.output-dir: expected a non-empty path");
  }

  return {
    mode,
    outputDir: path.resolve(outputDir),
  };
}

function shouldBypassManagedRuntime(): boolean {
  const explicit = (process.env.HIBOSS_MANAGED_RUNTIME ?? "").trim().toLowerCase();
  if (explicit === "1" || explicit === "true" || explicit === "force") {
    return false;
  }
  if (explicit === "0" || explicit === "false" || explicit === "off") {
    return true;
  }

  // In containerized runtimes, managed host orchestration (docker compose / pm2)
  // is usually unavailable and should be bypassed in favor of direct daemon control.
  if ((process.env.IS_SANDBOX ?? "").trim() === "1") {
    return true;
  }
  if (process.platform !== "win32" && fs.existsSync("/.dockerenv")) {
    return true;
  }

  return false;
}

function resolvePm2Command(): string {
  if (process.platform !== "win32") return "pm2";

  const candidates = [
    process.env.PM2_BIN,
    process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, "pm2.cmd") : undefined,
    "C:\\nvm4w\\nodejs\\pm2.cmd",
    "pm2.cmd",
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!candidate.includes("\\") && !candidate.includes("/")) {
      return candidate;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "pm2.cmd";
}

const PM2_COMMAND = resolvePm2Command();

function resolveDockerComposeCommand(): { command: string; baseArgs: string[] } {
  const dockerComposeModern = spawnSync("docker", ["compose", "version"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (dockerComposeModern.status === 0) {
    return { command: "docker", baseArgs: ["compose"] };
  }
  return { command: "docker-compose", baseArgs: [] };
}

const DOCKER_COMPOSE_COMMAND = resolveDockerComposeCommand();

function runPm2Command(args: string[], options: RunCommandOptions = {}): string {
  if (process.platform !== "win32") {
    return runCommand(PM2_COMMAND, args, options);
  }

  const cmdline = [quoteForCmd(PM2_COMMAND), ...args.map(quoteForCmd)].join(" ");
  return runCommand("cmd.exe", ["/d", "/s", "/c", cmdline], options);
}

function pm2ProcessExists(name: string, env: NodeJS.ProcessEnv): boolean {
  const result =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", `${quoteForCmd(PM2_COMMAND)} describe ${quoteForCmd(name)}`], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        })
      : spawnSync(PM2_COMMAND, ["describe", name], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        });
  return result.status === 0;
}

function runPm2(action: ManagedDaemonAction, outputDir: string): void {
  const ecosystemPath = path.join(outputDir, "ecosystem.config.cjs");
  const daemonConfig = getDefaultConfig();
  const hibossDir = (process.env.HIBOSS_DIR ?? "").trim() || daemonConfig.dataDir;
  const pm2Env: NodeJS.ProcessEnv = {
    ...process.env,
    HIBOSS_DIR: hibossDir,
    PM2_HOME: (process.env.PM2_HOME ?? "").trim() || path.join(hibossDir, ".pm2"),
  };

  if (action === "status") {
    runPm2Command(["describe", "hiboss-daemon"], { env: pm2Env });
    return;
  }

  if (action === "stop") {
    if (!pm2ProcessExists("hiboss-daemon", pm2Env)) {
      console.log("hiboss-daemon is already stopped.");
      return;
    }
    runPm2Command(["stop", "hiboss-daemon"], { env: pm2Env });
    return;
  }

  if (!fs.existsSync(ecosystemPath)) {
    throw new Error(`ecosystem.config.cjs not found at ${ecosystemPath}. Run 'hiboss setup' maintenance first.`);
  }

  runPm2Command(["startOrReload", ecosystemPath, "--only", "hiboss-daemon", "--update-env"], {
    env: pm2Env,
  });
}

function runDockerComposeCommand(args: string[], options: RunCommandOptions = {}): string {
  return runCommand(DOCKER_COMPOSE_COMMAND.command, [...DOCKER_COMPOSE_COMMAND.baseArgs, ...args], options);
}

const PROVIDER_ENV_SYNC_BEGIN = "# BEGIN hiboss-sync: providerCli.claude.env";
const PROVIDER_ENV_SYNC_END = "# END hiboss-sync: providerCli.claude.env";
const LEGACY_PROVIDER_ENV_SYNC_COMMENT = "# Synced from settings.json (single source of truth for provider env)";

function parseEnvFileLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  if (!key) return null;
  const value = trimmed.slice(eq + 1);
  return { key, value };
}

function readGlobalClaudeEnvFromSettings(hibossDir: string): Record<string, string> {
  const settingsPath = getSettingsPath(hibossDir);
  if (!fs.existsSync(settingsPath)) return {};

  const settings = readSettingsFile(hibossDir);
  const rawEnv = settings.providerCli?.claude?.env;
  if (!rawEnv || typeof rawEnv !== "object") return {};

  const env: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(rawEnv)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== "string") continue;
    env[key] = rawValue;
  }
  return env;
}

function syncDockerEnvFileFromSettings(params: { hibossDir: string; envFilePath: string }): void {
  if (!fs.existsSync(params.envFilePath)) return;

  const current = fs.readFileSync(params.envFilePath, "utf8");
  const lines = current.split(/\r?\n/);
  const claudeEnv = readGlobalClaudeEnvFromSettings(params.hibossDir);
  const managedKeys = new Set<string>([
    ...Object.keys(claudeEnv),
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
  ]);

  const nextLines: string[] = [];
  let insideManagedBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === PROVIDER_ENV_SYNC_BEGIN) {
      insideManagedBlock = true;
      continue;
    }
    if (trimmed === PROVIDER_ENV_SYNC_END) {
      insideManagedBlock = false;
      continue;
    }
    if (insideManagedBlock) {
      continue;
    }
    if (trimmed === LEGACY_PROVIDER_ENV_SYNC_COMMENT) {
      continue;
    }

    const parsed = parseEnvFileLine(line);
    if (!parsed) {
      nextLines.push(line);
      continue;
    }
    if (managedKeys.has(parsed.key)) {
      // Canonicalized from settings.json on each managed start.
      continue;
    }
    nextLines.push(line);
  }

  const insertions = Object.entries(claudeEnv).map(([key, value]) => `${key}=${value}`);

  if (insertions.length > 0) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim() !== "") {
      nextLines.push("");
    }
    nextLines.push(PROVIDER_ENV_SYNC_BEGIN);
    nextLines.push(...insertions);
    nextLines.push(PROVIDER_ENV_SYNC_END);
  }

  const normalized = `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
  if (normalized !== current) {
    fs.writeFileSync(params.envFilePath, normalized, "utf8");
  }
}

function resolveDockerRuntimeEnv(hibossDir: string): NodeJS.ProcessEnv {
  const dockerConfigDir = path.join(hibossDir, ".docker-runtime");
  try {
    fs.mkdirSync(dockerConfigDir, { recursive: true });
    const dockerConfigFile = path.join(dockerConfigDir, "config.json");
    if (!fs.existsSync(dockerConfigFile)) {
      fs.writeFileSync(dockerConfigFile, "{}\n", "utf8");
    }
  } catch {
    // Best effort only; docker CLI can still run with existing environment.
  }

  return {
    ...process.env,
    DOCKER_CONFIG: dockerConfigDir,
    COMPOSE_CONVERT_WINDOWS_PATHS:
      process.platform === "win32" ? "1" : process.env.COMPOSE_CONVERT_WINDOWS_PATHS,
  };
}

function runDocker(action: ManagedDaemonAction, outputDir: string): void {
  const composePath = path.join(outputDir, "docker-compose.yml");
  const daemonConfig = getDefaultConfig();
  const hibossDir = (process.env.HIBOSS_DIR ?? "").trim() || daemonConfig.dataDir;

  if (!fs.existsSync(composePath)) {
    throw new Error(`docker-compose.yml not found at ${composePath}. Run 'hiboss setup' maintenance first.`);
  }

  const envFilePath = path.join(outputDir, ".env.docker");
  if (action === "start" && fs.existsSync(envFilePath)) {
    syncDockerEnvFileFromSettings({ hibossDir, envFilePath });
  }

  const dockerEnv = resolveDockerRuntimeEnv(hibossDir);
  const commonArgs = [
    ...(fs.existsSync(envFilePath) ? ["--env-file", envFilePath] : []),
    "-f",
    composePath,
    "-p",
    "hiboss-daemon",
  ];

  if (action === "status") {
    runDockerComposeCommand([...commonArgs, "ps", "-a"], { env: dockerEnv });
    return;
  }

  if (action === "stop") {
    runDockerComposeCommand([...commonArgs, "down"], { env: dockerEnv });
    return;
  }

  try {
    runDockerComposeCommand([...commonArgs, "up", "-d"], { env: dockerEnv });
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (message.includes("already in progress") || message.includes("network") && message.includes("not found")) {
      try {
        const psOutput = runDockerComposeCommand([...commonArgs, "ps"], {
          env: dockerEnv,
          quiet: true,
        });
        const normalized = psOutput.toLowerCase();
        if (normalized.includes("hiboss-daemon") && normalized.includes("up")) {
          console.log("docker compose up raced with container removal; service is already running.");
          return;
        }
      } catch {
        // Fall through to rethrow original error.
      }
    }
    throw err;
  }
}

export function runManagedDaemonAction(action: ManagedDaemonAction): { handled: boolean; mode?: DeploymentMode } {
  const deployment = readDeploymentConfig();
  if (!deployment) return { handled: false };
  if (shouldBypassManagedRuntime()) {
    return { handled: false };
  }

  if (deployment.mode === "pm2") {
    runPm2(action, deployment.outputDir);
  } else {
    runDocker(action, deployment.outputDir);
  }

  if (action !== "status") {
    console.log(`Managed daemon action '${action}' applied via ${deployment.mode}.`);
  }

  return { handled: true, mode: deployment.mode };
}
