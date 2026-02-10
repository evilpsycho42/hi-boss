import { spawn } from "node:child_process";

export type UsageLike = {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  context_length?: number;
};

export async function runCli(options: {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.cmd, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code,
      });
    });
  });
}

export function parseClaudeStreamJsonUsage(stdout: string): {
  usage: UsageLike;
  sessionId?: string;
  assistantEvents: number;
} {
  let sessionId: string | undefined;
  let assistantEvents = 0;

  let resultUsage: Record<string, unknown> | undefined;
  let lastAssistantUsage: Record<string, unknown> | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (event?.type === "system" && event?.subtype === "init" && typeof event?.session_id === "string") {
      sessionId = event.session_id;
    }

    if (event?.type === "assistant") {
      assistantEvents += 1;
      const msgUsage = event?.message?.usage;
      if (msgUsage && typeof msgUsage === "object") {
        lastAssistantUsage = msgUsage as Record<string, unknown>;
      }
    }

    if (event?.type === "result" && event?.subtype === "success") {
      if (typeof event?.session_id === "string") {
        sessionId = event.session_id;
      }
      if (event?.usage && typeof event.usage === "object") {
        resultUsage = event.usage as Record<string, unknown>;
      }
    }
  }

  const inputTokens =
    resultUsage && typeof resultUsage.input_tokens === "number" ? (resultUsage.input_tokens as number) : null;
  const outputTokens =
    resultUsage && typeof resultUsage.output_tokens === "number" ? (resultUsage.output_tokens as number) : null;
  const cacheReadTokens =
    resultUsage && typeof resultUsage.cache_read_input_tokens === "number"
      ? (resultUsage.cache_read_input_tokens as number)
      : null;
  const cacheWriteTokens =
    resultUsage && typeof resultUsage.cache_creation_input_tokens === "number"
      ? (resultUsage.cache_creation_input_tokens as number)
      : null;

  // Prefer final-call prompt size from last assistant event.
  const finalCallInput =
    lastAssistantUsage && typeof lastAssistantUsage.input_tokens === "number"
      ? (lastAssistantUsage.input_tokens as number)
      : null;
  const finalCallCacheRead =
    lastAssistantUsage && typeof lastAssistantUsage.cache_read_input_tokens === "number"
      ? (lastAssistantUsage.cache_read_input_tokens as number)
      : 0;
  const finalCallCacheWrite =
    lastAssistantUsage && typeof lastAssistantUsage.cache_creation_input_tokens === "number"
      ? (lastAssistantUsage.cache_creation_input_tokens as number)
      : 0;
  const finalCallOutput =
    lastAssistantUsage && typeof lastAssistantUsage.output_tokens === "number"
      ? (lastAssistantUsage.output_tokens as number)
      : 0;
  const contextLength =
    finalCallInput !== null ? finalCallInput + finalCallCacheRead + finalCallCacheWrite + finalCallOutput : null;

  const totalTokens =
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;

  return {
    usage: {
      input_tokens: inputTokens ?? undefined,
      output_tokens: outputTokens ?? undefined,
      cache_read_tokens: cacheReadTokens ?? undefined,
      cache_write_tokens: cacheWriteTokens ?? undefined,
      context_length: contextLength ?? undefined,
      total_tokens: totalTokens ?? undefined,
    },
    sessionId,
    assistantEvents,
  };
}

export function parseCodexJsonUsage(stdout: string): { usage: UsageLike; threadId?: string } {
  let threadId: string | undefined;
  let turnUsage: Record<string, unknown> | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (event?.type === "thread.started" && typeof event?.thread_id === "string") {
      threadId = event.thread_id;
    }

    if (event?.type === "turn.completed" && event?.usage && typeof event.usage === "object") {
      turnUsage = event.usage as Record<string, unknown>;
    }
  }

  const inputTokens =
    turnUsage && typeof turnUsage.input_tokens === "number" ? (turnUsage.input_tokens as number) : null;
  const outputTokens =
    turnUsage && typeof turnUsage.output_tokens === "number" ? (turnUsage.output_tokens as number) : null;
  const cacheReadTokens =
    turnUsage && typeof turnUsage.cached_input_tokens === "number"
      ? (turnUsage.cached_input_tokens as number)
      : null;
  const totalTokens =
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  // NOTE: In Codex usage, `cached_input_tokens` is a breakdown (cache hits) within `input_tokens`.
  // Do not add it again.
  const contextLength =
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;

  return {
    usage: {
      input_tokens: inputTokens ?? undefined,
      output_tokens: outputTokens ?? undefined,
      cache_read_tokens: cacheReadTokens ?? undefined,
      context_length: contextLength ?? undefined,
      total_tokens: totalTokens ?? undefined,
    },
    threadId,
  };
}
