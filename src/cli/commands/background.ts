import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { authorizeCliOperation } from "../authz.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface AgentSelfResult {
  agent: {
    name: string;
    provider: "claude" | "codex";
    workspace: string;
    model?: string;
    reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh";
    autoLevel: "low" | "medium" | "high";
  };
}

export interface RunBackgroundOptions {
  token: string;
  task: string;
}

export async function runBackground(options: RunBackgroundOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    authorizeCliOperation("agent.background", options.token);
    const self = await client.call<AgentSelfResult>("agent.self", {
      token: options.token,
    });

    const tsPath = path.resolve(__dirname, "../../background-agent-entry.ts");
    const jsPath = path.resolve(__dirname, "../../background-agent-entry.js");

    let workerScript: string;
    let args: string[];
    let needsShell = false;

    if (fs.existsSync(tsPath) && process.argv[0]?.includes("tsx")) {
      workerScript = "tsx";
      args = [tsPath];
    } else if (fs.existsSync(jsPath)) {
      workerScript = process.execPath;
      args = [jsPath];
    } else if (fs.existsSync(tsPath)) {
      workerScript = "npx";
      args = ["tsx", tsPath];
      needsShell = true;
    } else {
      throw new Error("Background agent entry script not found");
    }

    args.push(
      "--agent-name",
      self.agent.name,
      "--provider",
      self.agent.provider,
      "--workspace",
      self.agent.workspace,
      "--reasoning-effort",
      self.agent.reasoningEffort,
      "--auto-level",
      self.agent.autoLevel,
      "--task",
      options.task
    );

    if (self.agent.model) {
      args.push("--model", self.agent.model);
    }

    const env = { ...process.env, HIBOSS_BACKGROUND_TOKEN: options.token };

    const child = spawn(workerScript, args, {
      detached: true,
      stdio: "ignore",
      env,
      shell: needsShell,
    });

    child.unref();
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}
