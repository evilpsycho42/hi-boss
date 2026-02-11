/**
 * CLI-based turn execution for agent runs.
 *
 * Spawns provider CLI processes (claude / codex) and parses JSONL output
 * for results, token usage, and session IDs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { AgentSession, TurnTokenUsage } from "./executor-support.js";
import { readTokenUsage } from "./executor-support.js";
import { HIBOSS_TOKEN_ENV } from "../shared/env.js";
import { getAgentInternalSpaceDir } from "./home-setup.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import {
  findCodexRolloutPathForThread,
  readCodexFinalCallTokenUsageFromRollout,
} from "./codex-rollout.js";
import { parseClaudeOutput, parseCodexOutput } from "./provider-cli-parsers.js";

export interface CliTurnResult {
  status: "success" | "cancelled";
  finalText: string;
  usage: TurnTokenUsage;
  /** Session/thread ID extracted from output (for resume). */
  sessionId?: string;
}

/**
 * Build CLI arguments for a Claude Code invocation.
 *
 * NOTE: The turn input is NOT included in args — it must be written to
 * the child process's stdin.  When `claude -p` is spawned with piped stdio
 * it ignores positional prompt arguments and reads from stdin instead.
 */
function buildClaudeArgs(
  session: AgentSession,
  hibossDir: string,
  agentName: string,
): string[] {
  const args: string[] = [
    "-p",
    "--append-system-prompt", session.systemInstructions,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
  ];

  const internalSpaceDir = getAgentInternalSpaceDir(agentName, hibossDir);
  args.push("--add-dir", internalSpaceDir);

  if (session.model) {
    args.push("--model", session.model);
  }

  // Resume if we have a session ID
  if (session.sessionId) {
    args.push("-r", session.sessionId);
  }

  return args;
}

/**
 * Build CLI arguments for a Codex invocation.
 */
function buildCodexArgs(
  session: AgentSession,
  turnInput: string,
  hibossDir: string,
  agentName: string,
): string[] {
  const internalSpaceDir = getAgentInternalSpaceDir(agentName, hibossDir);

  // Config overrides (supported by both `codex exec` and `codex exec resume`).
  // NOTE: We intentionally pass `developer_instructions` on every turn so resume
  // runs don't rely on prior thread history for Hi-Boss system behavior.
  const configArgs: string[] = ["-c", `developer_instructions=${session.systemInstructions}`];
  if (session.reasoningEffort) {
    // Codex config key uses TOML strings; quote so parsing is stable.
    configArgs.push("-c", `model_reasoning_effort="${session.reasoningEffort}"`);
  }

  const modelArgs: string[] = session.model ? ["-m", session.model] : [];

  if (session.sessionId) {
    const resumeArgs: string[] = ["exec", "resume", "--json", "--skip-git-repo-check"];

    // Always bypass approvals and sandboxing for reliable agent operation.
    resumeArgs.push("--dangerously-bypass-approvals-and-sandbox");

    resumeArgs.push(...configArgs, ...modelArgs, session.sessionId, turnInput);
    return resumeArgs;
  }

  const freshArgs: string[] = ["exec", "--json", "--skip-git-repo-check"];

  // Always bypass approvals and sandboxing for reliable agent operation.
  freshArgs.push("--dangerously-bypass-approvals-and-sandbox");

  // Additional directories (only supported on fresh `codex exec`).
  freshArgs.push("--add-dir", internalSpaceDir);

  freshArgs.push(...configArgs, ...modelArgs, turnInput);
  return freshArgs;
}

/**
 * Execute a single turn by spawning a provider CLI process.
 */
export async function executeCliTurn(
  session: AgentSession,
  turnInput: string,
  options: {
    hibossDir: string;
    agentName: string;
    signal?: AbortSignal;
    onChildProcess?: (proc: ChildProcess) => void;
  },
): Promise<CliTurnResult> {
  const { hibossDir, agentName, signal } = options;

  const cmd = session.provider === "claude" ? "claude" : "codex";
  const args =
    session.provider === "claude"
      ? buildClaudeArgs(session, hibossDir, agentName)
      : buildCodexArgs(session, turnInput, hibossDir, agentName);

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    [HIBOSS_TOKEN_ENV]: session.agentToken,
  };

  // Provider CLIs support "home" overrides via env vars, but Hi-Boss intentionally
  // forces the shared default homes for stable behavior across machines:
  // - Claude: ~/.claude (override var: CLAUDE_CONFIG_DIR)
  // - Codex:  ~/.codex  (override var: CODEX_HOME)
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;

  return new Promise<CliTurnResult>((resolve, reject) => {
    let cancelled = false;
    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];

    const child = spawn(cmd, args, {
      cwd: session.workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    session.childProcess = child;
    options.onChildProcess?.(child);

    // Claude -p with piped stdio reads the prompt from stdin (positional args
    // are ignored).  Write the turn input and close stdin so the CLI proceeds.
    // For Codex the prompt is a positional arg; close stdin immediately.
    if (session.provider === "claude") {
      child.stdin?.write(turnInput);
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
        // Kill the process group for thorough cleanup
        if (child.pid) {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        child.kill("SIGTERM");
      }
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("close", (code, closeSignal) => {
      session.childProcess = undefined;
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");

      if (cancelled) {
        resolve({
          status: "cancelled",
          finalText: "",
          usage: readTokenUsage({}),
        });
        return;
      }

      if (code !== 0 && code !== null) {
        const errMsg = stderr.trim() || `CLI exited with code ${code}`;
        logEvent("warn", "agent-cli-exit-nonzero", {
          "agent-name": agentName,
          provider: session.provider,
          "exit-code": code,
          stderr: stderr.slice(0, 500),
        });
        reject(new Error(`${cmd} exited with code ${code}: ${errMsg.slice(0, 300)}`));
        return;
      }

      if (code === null) {
        const sig = closeSignal ?? "unknown-signal";
        logEvent("warn", "agent-cli-exit-signal", {
          "agent-name": agentName,
          provider: session.provider,
          signal: sig,
          stderr: stderr.slice(0, 500),
        });
        reject(new Error(`${cmd} terminated by signal: ${sig}`));
        return;
      }

      try {
        const parsed = session.provider === "claude" ? parseClaudeOutput(stdout) : parseCodexOutput(stdout);

        (async () => {
          // Best-effort: for Codex, refine context-length using the rollout log’s token_count events.
          if (session.provider === "codex") {
            const parsedCodex = parsed as ReturnType<typeof parseCodexOutput>;
            const threadId = parsed.sessionId ?? session.sessionId;
            const rolloutPath = threadId ? await findCodexRolloutPathForThread(threadId) : null;
            if (rolloutPath) {
              const lastUsage = await readCodexFinalCallTokenUsageFromRollout(rolloutPath);
              if (lastUsage) {
                // Context-length is the final model call's size (prompt + output).
                // NOTE: In Codex usage, `cached_input_tokens` is a breakdown of `input_tokens`
                // (cache hits), not an additional bucket. Do not add it again.
                parsed.usage.contextLength = lastUsage.inputTokens + lastUsage.outputTokens;
              }
            }

            // Token usage (debug-only): Codex `turn.completed.usage` is cumulative across the
            // session thread; compute per-turn deltas using the last observed cumulative totals.
            const currentTotals = parsedCodex.codexCumulativeUsage;
            if (currentTotals) {
              let appliedTurnTotals = false;
              const hasPriorTotals = Boolean(session.codexCumulativeUsageTotals);
              const isResume = typeof session.sessionId === "string" && session.sessionId.trim().length > 0;
              const prevTotals = hasPriorTotals
                ? session.codexCumulativeUsageTotals
                : isResume
                  ? null
                  : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

              if (prevTotals) {
                const deltaInput = currentTotals.inputTokens - prevTotals.inputTokens;
                const deltaCached = currentTotals.cachedInputTokens - prevTotals.cachedInputTokens;
                const deltaOutput = currentTotals.outputTokens - prevTotals.outputTokens;

                if (deltaInput >= 0 && deltaCached >= 0 && deltaOutput >= 0) {
                  parsed.usage.inputTokens = deltaInput;
                  parsed.usage.outputTokens = deltaOutput;
                  parsed.usage.cacheReadTokens = deltaCached;
                  parsed.usage.cacheWriteTokens = null;
                  parsed.usage.totalTokens = deltaInput + deltaOutput;
                  appliedTurnTotals = true;
                }
              }

              // Always store the new cumulative totals for the next run.
              session.codexCumulativeUsageTotals = currentTotals;
            }
          }

          resolve({
            status: "success",
            finalText: parsed.finalText,
            usage: parsed.usage,
            sessionId: parsed.sessionId,
          });
        })().catch((err) => {
          logEvent("warn", "agent-codex-context-length-enrich-failed", {
            "agent-name": agentName,
            provider: session.provider,
            error: errorMessage(err),
          });
          resolve({
            status: "success",
            finalText: parsed.finalText,
            usage: parsed.usage,
            sessionId: parsed.sessionId,
          });
        });
      } catch (err) {
        reject(new Error(`Failed to parse ${cmd} output: ${errorMessage(err)}`));
      }
    });

    child.on("error", (err) => {
      session.childProcess = undefined;
      reject(new Error(`Failed to spawn ${cmd}: ${errorMessage(err)}`));
    });
  });
}
