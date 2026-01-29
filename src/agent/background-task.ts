import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createRuntime,
  type UnifiedAgentRuntime,
  type UnifiedSession,
} from "@unified-agent-sdk/runtime";
import { getAgentHomePath } from "./home-setup.js";
import { getDefaultConfig, getSocketPath } from "../daemon/daemon.js";
import { IpcClient } from "../cli/ipc-client.js";

export interface BackgroundTaskOptions {
  agentName: string;
  provider: "claude" | "codex";
  workspace: string;
  model?: string;
  reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh";
  autoLevel: "low" | "medium" | "high";
  task: string;
}

async function sendEnvelopeToSelf(
  token: string,
  agentName: string,
  text: string
): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));
  await client.call("envelope.send", { token, to: `agent:${agentName}`, text });
}

export async function runBackgroundTask(options: BackgroundTaskOptions): Promise<void> {
  const backgroundToken = process.env.HIBOSS_BACKGROUND_TOKEN?.trim();
  if (!backgroundToken) {
    throw new Error("Missing HIBOSS_BACKGROUND_TOKEN");
  }

  // Prevent the model run from discovering an auth token via env.
  delete process.env.HIBOSS_BACKGROUND_TOKEN;
  delete process.env.HIBOSS_TOKEN;

  const baseHome = getAgentHomePath(options.agentName, options.provider);
  if (!fs.existsSync(baseHome)) {
    throw new Error(`Agent home not found: ${baseHome}`);
  }

  let runtime: UnifiedAgentRuntime<any, any> | null = null;
  let session: UnifiedSession<any, any> | null = null;
  let tempParent: string | null = null;

  try {
    tempParent = fs.mkdtempSync(
      path.join(os.tmpdir(), `hiboss-bg-${options.agentName}-`)
    );
    const tempHome = path.join(tempParent, path.basename(baseHome));

    fs.cpSync(baseHome, tempHome, { recursive: true, force: true });

    // Remove injected system prompt files (no AGENTS.md / CLAUDE.md).
    for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
      const p = path.join(tempHome, filename);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
      }
    }

    const defaultOpts = {
      workspace: { cwd: options.workspace },
      access: { auto: options.autoLevel },
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    };

    runtime =
      options.provider === "claude"
        ? createRuntime({
            provider: "@anthropic-ai/claude-agent-sdk",
            home: tempHome,
            env: {},
            defaultOpts,
          })
        : createRuntime({
            provider: "@openai/codex-sdk",
            home: tempHome,
            env: {},
            defaultOpts,
          });

    session = await runtime.openSession({});
    const runHandle = await session.run({
      input: { parts: [{ type: "text", text: options.task }] },
    });

    for await (const _ of runHandle.events) {
      // Drain events.
    }

    const result = await runHandle.result;
    if (result.status !== "success") {
      throw new Error(`Agent run ${result.status}`);
    }

    const finalText = result.finalText ?? "";
    await sendEnvelopeToSelf(backgroundToken, options.agentName, finalText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendEnvelopeToSelf(backgroundToken, options.agentName, `error: ${message}`).catch(() => {
      // Best-effort: ignore notify failure.
    });
    throw err;
  } finally {
    await session?.dispose().catch(() => {});
    await runtime?.close().catch(() => {});
    if (tempParent) {
      fs.rmSync(tempParent, { recursive: true, force: true });
    }
  }
}

