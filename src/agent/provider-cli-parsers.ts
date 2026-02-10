import type { TurnTokenUsage } from "./executor-support.js";
import { readTokenUsage } from "./executor-support.js";

/**
 * Parse Claude stream-json JSONL output.
 */
export function parseClaudeOutput(stdout: string): {
  finalText: string;
  usage: TurnTokenUsage;
  sessionId?: string;
} {
  let finalText = "";
  let usage: TurnTokenUsage = {
    contextLength: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
  };
  let sessionId: string | undefined;

  // Track the last assistant event's usage for accurate context length.
  // The `result.usage` aggregates ALL model calls in a turn (tool loops),
  // which overcounts context. Each `type:"assistant"` event carries the
  // per-call `message.usage` — the last one reflects the final prompt size.
  let lastAssistantContextLength: number | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;

      // Per-call usage from assistant events (each model call emits one).
      if (event.type === "assistant") {
        const msg = event.message as Record<string, unknown> | undefined;
        const msgUsage = msg?.usage as Record<string, unknown> | undefined;
        if (msgUsage && typeof msgUsage.input_tokens === "number") {
          const input = msgUsage.input_tokens as number;
          const output = typeof msgUsage.output_tokens === "number" ? (msgUsage.output_tokens as number) : 0;
          const cacheRead =
            typeof msgUsage.cache_read_input_tokens === "number" ? (msgUsage.cache_read_input_tokens as number) : 0;
          const cacheWrite =
            typeof msgUsage.cache_creation_input_tokens === "number"
              ? (msgUsage.cache_creation_input_tokens as number)
              : 0;
          lastAssistantContextLength = input + cacheRead + cacheWrite + output;
        }
      }

      if (event.type === "result" && event.subtype === "success") {
        finalText = typeof event.result === "string" ? event.result : finalText;
        if (typeof event.session_id === "string") {
          sessionId = event.session_id;
        }
        if (event.usage && typeof event.usage === "object") {
          const usageRaw = event.usage as Record<string, unknown>;
          // Aggregate input/output/cache tokens from result.usage (for billing).
          // Context length uses the last assistant event (accurate per-call value).
          usage = readTokenUsage({
            input_tokens: usageRaw.input_tokens,
            output_tokens: usageRaw.output_tokens,
            cache_read_tokens: usageRaw.cache_read_input_tokens,
            cache_write_tokens: usageRaw.cache_creation_input_tokens,
            total_tokens:
              typeof usageRaw.input_tokens === "number" && typeof usageRaw.output_tokens === "number"
                ? (usageRaw.input_tokens as number) + (usageRaw.output_tokens as number)
                : undefined,
            context_length: lastAssistantContextLength,
          });
        }
      }

      // Also capture session_id from init events
      if (event.type === "system" && event.subtype === "init") {
        if (typeof event.session_id === "string") {
          sessionId = event.session_id;
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return { finalText, usage, sessionId };
}

/**
 * Parse Codex --json JSONL output.
 */
export function parseCodexOutput(stdout: string): {
  finalText: string;
  usage: TurnTokenUsage;
  sessionId?: string;
  codexCumulativeUsage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
} {
  let finalText = "";
  let usage: TurnTokenUsage = {
    contextLength: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
  };
  let sessionId: string | undefined;
  let lastAgentMessage = "";
  let codexCumulativeUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;

      if (event.type === "thread.started") {
        if (typeof event.thread_id === "string") {
          sessionId = event.thread_id;
        }
      }

      // Capture agent messages for final text
      if (event.type === "item.completed") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message") {
          // Observed shapes:
          // - { type:"agent_message", text:"..." }
          // - { type:"agent_message", content:[{type:"output_text", text:"..."}] }
          const text = item.text;
          let candidateText = typeof text === "string" ? text : "";

          if (!candidateText) {
            const content = item.content;
            if (Array.isArray(content)) {
              candidateText = content
                .filter((part) => typeof part === "object" && part !== null)
                .filter((part) => (part as Record<string, unknown>).type === "output_text")
                .map((part) => (part as Record<string, unknown>).text)
                .filter((t) => typeof t === "string")
                .join("");
            }
          }

          if (candidateText.trim().length > 0) {
            lastAgentMessage = candidateText;
          }
        }
      }

      // Capture usage from turn.completed
      if (event.type === "turn.completed") {
        const turnUsage = event.usage as Record<string, unknown> | undefined;
        if (turnUsage) {
          const inputTokens = typeof turnUsage.input_tokens === "number" ? (turnUsage.input_tokens as number) : null;
          const cachedInputTokens =
            typeof turnUsage.cached_input_tokens === "number" ? (turnUsage.cached_input_tokens as number) : null;
          const outputTokens = typeof turnUsage.output_tokens === "number" ? (turnUsage.output_tokens as number) : null;
          if (
            inputTokens !== null &&
            cachedInputTokens !== null &&
            outputTokens !== null &&
            Number.isFinite(inputTokens) &&
            Number.isFinite(cachedInputTokens) &&
            Number.isFinite(outputTokens)
          ) {
            codexCumulativeUsage = { inputTokens, cachedInputTokens, outputTokens };
          }
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  finalText = lastAgentMessage;
  return { finalText, usage, sessionId, ...(codexCumulativeUsage ? { codexCumulativeUsage } : {}) };
}
