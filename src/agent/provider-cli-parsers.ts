import type { TurnTokenUsage } from "./executor-support.js";
import { readTokenUsage } from "./executor-support.js";

export interface ProviderTraceEntry {
  type: "assistant" | "tool-call";
  text: string;
  toolName?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeTraceText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function truncateText(raw: string, maxLen: number): string {
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, Math.max(1, maxLen - 3))}...`;
}

function summarizeToolInput(input: unknown, maxLen: number): string | null {
  if (input === undefined) return null;
  try {
    const serialized = typeof input === "string" ? input : JSON.stringify(input);
    const normalized = normalizeTraceText(serialized);
    if (!normalized) return null;
    return truncateText(normalized, maxLen);
  } catch {
    return null;
  }
}

function extractCodexMessageText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((partRaw) => {
      const part = asRecord(partRaw);
      if (!part) return "";
      const partType = typeof part.type === "string" ? part.type : "";
      const text = typeof part.text === "string" ? part.text : "";
      if (!text) return "";
      if (partType === "output_text" || partType === "text") {
        return text;
      }
      return "";
    })
    .join("");
}

function getCodexAssistantText(item: Record<string, unknown>): string | null {
  const itemType = typeof item.type === "string" ? item.type : "";
  const senderKey = "r" + "ole";
  const senderKind = typeof item[senderKey] === "string" ? item[senderKey] : "";
  const isAssistantMessage =
    itemType === "agent_message" ||
    itemType === "assistant_message" ||
    (itemType === "message" && senderKind === "assistant");

  if (!isAssistantMessage) {
    return null;
  }

  const candidateText = extractCodexMessageText(
    typeof item.text === "string" ? item.text : item.content
  );
  const normalized = normalizeTraceText(candidateText);
  return normalized || null;
}

function getToolName(record: Record<string, unknown>): string | null {
  const directCandidates = [
    record.name,
    record.tool_name,
    record.toolName,
    record.function_name,
    record.call_name,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const functionObj = asRecord(record.function);
  if (functionObj && typeof functionObj.name === "string" && functionObj.name.trim()) {
    return functionObj.name.trim();
  }

  const toolObj = asRecord(record.tool);
  if (toolObj && typeof toolObj.name === "string" && toolObj.name.trim()) {
    return toolObj.name.trim();
  }

  return null;
}

function getToolInput(record: Record<string, unknown>): unknown {
  const orderedKeys = [
    "input",
    "arguments",
    "args",
    "params",
    "tool_input",
    "call_input",
    "payload",
  ];
  for (const key of orderedKeys) {
    if (Object.hasOwn(record, key)) {
      return record[key];
    }
  }

  const functionObj = asRecord(record.function);
  if (functionObj) {
    if (Object.hasOwn(functionObj, "arguments")) return functionObj.arguments;
    if (Object.hasOwn(functionObj, "input")) return functionObj.input;
  }

  return undefined;
}

function isCodexToolCallItemType(itemType: string): boolean {
  const normalized = itemType.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "tool_call" || normalized === "tool_use" || normalized === "function_call") {
    return true;
  }
  if (normalized.endsWith("_call") || normalized.endsWith(".call")) {
    return true;
  }
  if (normalized.includes("tool") && normalized.includes("call")) {
    return true;
  }
  return false;
}

function buildToolCallEntry(
  record: Record<string, unknown>,
  options: { maxTextLength: number; maxToolInputLength: number }
): ProviderTraceEntry | null {
  const toolName = getToolName(record) ?? "unknown";
  const inputSummary = summarizeToolInput(getToolInput(record), options.maxToolInputLength);
  const text = inputSummary ? `${toolName} input=${inputSummary}` : toolName;
  const normalized = normalizeTraceText(text);
  if (!normalized) return null;
  return {
    type: "tool-call",
    toolName,
    text: truncateText(normalized, options.maxTextLength),
  };
}

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
        const item = asRecord(event.item);
        if (item) {
          const assistantText = getCodexAssistantText(item);
          if (assistantText) {
            lastAgentMessage = assistantText;
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

/**
 * Parse Codex --json output and extract user-facing run trace entries.
 *
 * Included:
 * - assistant textual outputs
 * - tool calls
 *
 * Excluded:
 * - reasoning
 * - tool results
 */
export function parseCodexTraceEntries(
  stdout: string,
  options: { maxEntries?: number; maxTextLength?: number; maxToolInputLength?: number } = {}
): ProviderTraceEntry[] {
  const maxEntries = options.maxEntries ?? 40;
  const maxTextLength = options.maxTextLength ?? 260;
  const maxToolInputLength = options.maxToolInputLength ?? 220;
  const out: ProviderTraceEntry[] = [];

  const pushEntry = (entry: ProviderTraceEntry): void => {
    if (out.length > 0) {
      const prev = out[out.length - 1]!;
      if (prev.type === entry.type && prev.text === entry.text && prev.toolName === entry.toolName) {
        return;
      }
    }
    out.push(entry);
    if (out.length > maxEntries) {
      out.shift();
    }
  };

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: Record<string, unknown> | null = null;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const eventType = typeof event.type === "string" ? event.type : "";

    const item = asRecord(event.item);
    if (eventType === "item.completed" && item) {
      const assistantText = getCodexAssistantText(item);
      if (assistantText) {
        pushEntry({
          type: "assistant",
          text: truncateText(assistantText, maxTextLength),
        });
      }

      const itemType = typeof item.type === "string" ? item.type : "";
      if (isCodexToolCallItemType(itemType)) {
        const toolEntry = buildToolCallEntry(item, { maxTextLength, maxToolInputLength });
        if (toolEntry) {
          pushEntry(toolEntry);
        }
      }
      continue;
    }

    // Some Codex versions may surface top-level tool call events.
    if (isCodexToolCallItemType(eventType)) {
      const toolEntry = buildToolCallEntry(event, { maxTextLength, maxToolInputLength });
      if (toolEntry) {
        pushEntry(toolEntry);
      }
    }
  }

  return out;
}

/**
 * Extract a human-readable failure reason from Codex JSONL output.
 *
 * Codex often reports runtime/API errors on stdout as JSON events even when stderr
 * is empty. Prefer turn.failed message, then fallback to the last error event.
 */
export function parseCodexFailureMessage(stdout: string): string | null {
  let turnFailedMessage: string | null = null;
  let lastErrorMessage: string | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;

      if (event.type === "error" && typeof event.message === "string" && event.message.trim()) {
        lastErrorMessage = event.message.trim();
        continue;
      }

      if (event.type !== "turn.failed") {
        continue;
      }

      const error = event.error;
      if (typeof error === "string" && error.trim()) {
        turnFailedMessage = error.trim();
        continue;
      }
      if (typeof error === "object" && error !== null) {
        const maybeMessage = (error as Record<string, unknown>).message;
        if (typeof maybeMessage === "string" && maybeMessage.trim()) {
          turnFailedMessage = maybeMessage.trim();
        }
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return turnFailedMessage ?? lastErrorMessage;
}

/**
 * Parse Claude stream-json output and extract user-facing run trace entries.
 *
 * Included:
 * - assistant textual outputs
 * - tool calls
 *
 * Excluded:
 * - thinking blocks
 * - tool results
 */
export function parseClaudeTraceEntries(
  stdout: string,
  options: { maxEntries?: number; maxTextLength?: number; maxToolInputLength?: number } = {}
): ProviderTraceEntry[] {
  const maxEntries = options.maxEntries ?? 40;
  const maxTextLength = options.maxTextLength ?? 260;
  const maxToolInputLength = options.maxToolInputLength ?? 220;
  const out: ProviderTraceEntry[] = [];

  const pushEntry = (entry: ProviderTraceEntry): void => {
    if (out.length > 0) {
      const prev = out[out.length - 1]!;
      if (prev.type === entry.type && prev.text === entry.text && prev.toolName === entry.toolName) {
        return;
      }
    }
    out.push(entry);
    if (out.length > maxEntries) {
      out.shift();
    }
  };

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: Record<string, unknown> | null = null;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const eventType = typeof event.type === "string" ? event.type : "";

    // Some CLI versions may emit top-level tool_use events.
    if (eventType === "tool_use") {
      const toolNameRaw = typeof event.name === "string" ? event.name.trim() : "";
      const toolName = toolNameRaw || "unknown";
      const inputSummary = summarizeToolInput(event.input, maxToolInputLength);
      const text = inputSummary ? `${toolName} input=${inputSummary}` : toolName;
      pushEntry({
        type: "tool-call",
        toolName,
        text: truncateText(text, maxTextLength),
      });
      continue;
    }

    if (eventType !== "assistant") {
      continue;
    }

    const message = asRecord(event.message);
    if (!message) {
      continue;
    }

    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const partRaw of content) {
      const part = asRecord(partRaw);
      if (!part) continue;
      const partType = typeof part.type === "string" ? part.type : "";

      if (partType === "text") {
        const textRaw = typeof part.text === "string" ? part.text : "";
        const normalized = normalizeTraceText(textRaw);
        if (!normalized) continue;
        pushEntry({
          type: "assistant",
          text: truncateText(normalized, maxTextLength),
        });
        continue;
      }

      if (partType === "tool_use") {
        const toolNameRaw = typeof part.name === "string" ? part.name.trim() : "";
        const toolName = toolNameRaw || "unknown";
        const inputSummary = summarizeToolInput(part.input, maxToolInputLength);
        const text = inputSummary ? `${toolName} input=${inputSummary}` : toolName;
        pushEntry({
          type: "tool-call",
          toolName,
          text: truncateText(text, maxTextLength),
        });
      }
    }
  }

  return out;
}
