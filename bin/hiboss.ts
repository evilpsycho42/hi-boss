#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { getHiBossRootDir } from "../src/shared/hiboss-paths.js";
import { getSettingsPath } from "../src/shared/settings-io.js";
import { program } from "../src/cli/cli.js";

type DeploymentConfig = {
  mode: "docker" | "pm2";
  outputDir: string;
};

const PROXY_TOP_LEVEL_COMMANDS = new Set(["agent", "team", "envelope", "reaction", "cron"]);

function readDeploymentConfig(): DeploymentConfig | null {
  try {
    const settingsPath = getSettingsPath(getHiBossRootDir());
    if (!fs.existsSync(settingsPath)) return null;
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const runtime = raw.runtime as Record<string, unknown> | undefined;
    const deploymentRaw = runtime?.deployment;
    if (!deploymentRaw || typeof deploymentRaw !== "object" || Array.isArray(deploymentRaw)) return null;
    const deployment = deploymentRaw as Record<string, unknown>;
    const mode = typeof deployment.mode === "string" ? deployment.mode.trim().toLowerCase() : "";
    if (mode !== "docker" && mode !== "pm2") return null;
    const outputDirRaw =
      typeof deployment["output-dir"] === "string"
        ? deployment["output-dir"]
        : typeof deployment.outputDir === "string"
          ? deployment.outputDir
          : "";
    const outputDir = outputDirRaw.trim();
    if (!outputDir) return null;
    return {
      mode,
      outputDir,
    };
  } catch {
    return null;
  }
}

function shouldProxyCommandToDocker(argv: string[]): boolean {
  if (process.platform !== "win32") return false;
  const deployment = readDeploymentConfig();
  if (!deployment || deployment.mode !== "docker") return false;

  const top = (argv[0] ?? "").trim().toLowerCase();
  if (!top) return false;
  return PROXY_TOP_LEVEL_COMMANDS.has(top);
}

function proxyCommandToDocker(argv: string[]): never {
  const result = spawnSync("docker", ["exec", "-i", "hiboss-daemon", "node", "/workspace/dist/bin/hiboss.js", ...argv], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error("error:", result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const argv = process.argv.slice(2);
if (shouldProxyCommandToDocker(argv)) {
  proxyCommandToDocker(argv);
}

program.parse();
