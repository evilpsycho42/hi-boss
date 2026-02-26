import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HIBOSS_TOKEN_ENV } from "../shared/env.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import { parseCodexFailureMessage } from "./provider-cli-parsers.js";

export type OneShotProvider = "claude" | "codex";

export interface ExecuteOneShotPromptParams {
  provider: OneShotProvider;
  workspace: string;
  prompt: string;
  envOverrides?: Record<string, string>;
  model?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  signal?: AbortSignal;
  onChildProcess?: (proc: ChildProcess) => void;
}

function buildClaudeArgs(params: { model?: string }): string[] {
  const args: string[] = [
    "-p",
    "--output-format", "text",
    "--permission-mode", "bypassPermissions",
  ];

  if (params.model) {
    args.push("--model", params.model);
  }

  return args;
}

function buildCodexArgs(params: {
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  outputLastMessagePath: string;
}): string[] {
  const args: string[] = ["exec", "--skip-git-repo-check", "-o", params.outputLastMessagePath];

  // Non-interactive execution (no approvals/sandbox prompts).
  args.push("--dangerously-bypass-approvals-and-sandbox");

  if (params.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${params.reasoningEffort}"`);
  }
  if (params.model) {
    args.push("-m", params.model);
  }

  args.push(params.prompt);
  return args;
}

function buildTempOutputPath(): string {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(tmpdir(), `hiboss-oneshot-codex-last-message-${suffix}.txt`);
}

/**
 * Execute a one-shot provider CLI prompt without Hi-Boss system instructions and without `HIBOSS_TOKEN`.
 */
export async function executeOneShotPrompt(params: ExecuteOneShotPromptParams): Promise<{ finalText: string }> {
  const cmd = params.provider === "claude" ? "claude" : "codex";
  let outputLastMessagePath: string | undefined;
  const args =
    params.provider === "claude"
      ? buildClaudeArgs({ model: params.model })
      : (() => {
          outputLastMessagePath = buildTempOutputPath();
          return buildCodexArgs({
            prompt: params.prompt,
            model: params.model,
            reasoningEffort: params.reasoningEffort,
            outputLastMessagePath,
          });
        })();

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  // Ensure one-shot executions do not inherit the Hi-Boss token.
  delete env[HIBOSS_TOKEN_ENV];

  // Start from shared default provider homes for stable behavior across machines.
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  if (params.envOverrides) {
    for (const [key, value] of Object.entries(params.envOverrides)) {
      env[key] = value;
    }
  }

  return new Promise<{ finalText: string }>((resolve, reject) => {
    let cancelled = false;
    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];

    const child = spawn(cmd, args, {
      cwd: params.workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    params.onChildProcess?.(child);

    const cleanupCodexOutputFile = async (): Promise<void> => {
      if (!outputLastMessagePath) return;
      try {
        await unlink(outputLastMessagePath);
      } catch {
        // Best-effort temp file cleanup.
      }
    };

    // Claude reads prompt from stdin when -p is used with piped stdio.
    if (params.provider === "claude") {
      child.stdin?.write(params.prompt);
    }
    child.stdin?.end();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    const onAbort = () => {
      cancelled = true;
      try {
        if (child.pid) {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        child.kill("SIGTERM");
      }
    };

    if (params.signal) {
      if (params.signal.aborted) {
        onAbort();
      } else {
        params.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("close", (code, closeSignal) => {
      if (params.signal) {
        params.signal.removeEventListener("abort", onAbort);
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");

      if (cancelled) {
        void cleanupCodexOutputFile();
        resolve({ finalText: "" });
        return;
      }

      if (code !== 0 && code !== null) {
        void cleanupCodexOutputFile();
        const codexFailureMessage =
          params.provider === "codex" ? parseCodexFailureMessage(stdout) : null;
        const errMsg = stderr.trim() || codexFailureMessage || `CLI exited with code ${code}`;
        logEvent("warn", "oneshot-cli-exit-nonzero", {
          provider: params.provider,
          "exit-code": code,
          stderr: stderr.slice(0, 500),
          ...(codexFailureMessage ? { "codex-failure-message": codexFailureMessage.slice(0, 500) } : {}),
        });
        reject(new Error(`${cmd} exited with code ${code}: ${errMsg.slice(0, 300)}`));
        return;
      }

      if (code === null) {
        void cleanupCodexOutputFile();
        const sig = closeSignal ?? "unknown-signal";
        logEvent("warn", "oneshot-cli-exit-signal", {
          provider: params.provider,
          signal: sig,
          stderr: stderr.slice(0, 500),
        });
        reject(new Error(`${cmd} terminated by signal: ${sig}`));
        return;
      }

      void (async () => {
        let finalText = stdout.trim();

        if (params.provider === "codex" && outputLastMessagePath) {
          try {
            const text = (await readFile(outputLastMessagePath, "utf-8")).trim();
            if (text) {
              finalText = text;
            }
          } catch (err) {
            logEvent("warn", "oneshot-codex-output-read-failed", {
              error: errorMessage(err),
            });
          } finally {
            await cleanupCodexOutputFile();
          }
        }

        resolve({ finalText });
      })().catch((err) => {
        void cleanupCodexOutputFile();
        reject(err);
      });
    });

    child.on("error", (err) => {
      void cleanupCodexOutputFile();
      reject(new Error(`Failed to spawn ${cmd}: ${errorMessage(err)}`));
    });
  });
}
