import * as readline from "node:readline";
import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { resolveToken } from "../token.js";
import type { SessionListResult } from "../../daemon/ipc/types.js";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type AgentListResult = {
  agents: Array<{
    name: string;
    provider?: "claude" | "codex";
    workspace?: string;
    model?: string;
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
    permissionLevel?: "restricted" | "standard" | "privileged" | "admin";
  }>;
};

type EnvelopeSendResult = {
  id: string;
  interruptedWork?: boolean;
  priorityApplied?: boolean;
};

type EnvelopeListResult = {
  envelopes: Array<{
    id: string;
    from: string;
    to: string;
    createdAt: number;
    deliverAt?: number;
    content: {
      text?: string;
      attachments?: Array<{ source: string; filename?: string; telegramFileId?: string }>;
    };
  }>;
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-11-05"] as const;

const MCP_TOOLS: McpTool[] = [
  {
    name: "hiboss_agent_list",
    description: "List available Hi-Boss agents.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
  },
  {
    name: "hiboss_session_list",
    description: "List sessions for an agent. Defaults to current agent when agentName is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        agentName: { type: "string", description: "Target agent name (optional)." },
        limit: { type: "number", description: "Max sessions to return (1..100, default 20)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "hiboss_envelope_send",
    description: "Send an envelope to an agent or channel, optionally pinning to a specific target session.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destination address, e.g. agent:nex or channel:telegram:1234." },
        text: { type: "string", description: "Message text." },
        deliverAt: { type: "string", description: "ISO8601 or relative time, e.g. +30m." },
        interruptNow: { type: "boolean", description: "Interrupt current run for agent destinations." },
        parseMode: { type: "string", enum: ["plain", "markdownv2", "html"] },
        replyToEnvelopeId: { type: "string", description: "Envelope id to reply to." },
        toSessionId: { type: "string", description: "Target Hi-Boss session id (short/prefix/full UUID)." },
        toProviderSessionId: { type: "string", description: "Target provider session/thread id." },
        toProvider: { type: "string", enum: ["claude", "codex"] },
      },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: "hiboss_envelope_list",
    description: "List envelopes by to/from relationship for the current agent token.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "List envelopes sent by this agent to this address." },
        from: { type: "string", description: "List envelopes sent to this agent from this address." },
        status: { type: "string", enum: ["pending", "done"] },
        limit: { type: "number", description: "Max envelopes to return (default 10)." },
        createdAfter: { type: "string", description: "Optional lower time bound." },
        createdBefore: { type: "string", description: "Optional upper time bound." },
      },
      required: ["status"],
      additionalProperties: false,
    },
  },
];

function writeJsonLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function toProtocolError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

function assertObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object");
  }
  return value as Record<string, unknown>;
}

function toToolCallError(message: string, data?: unknown): ToolCallResult {
  const body = data && typeof data === "object" ? `${message}\n${JSON.stringify(data, null, 2)}` : message;
  return {
    content: [{ type: "text", text: body }],
    isError: true,
    ...(data && typeof data === "object" ? { structuredContent: data as Record<string, unknown> } : {}),
  };
}

function parseLimit(raw: unknown, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error("Invalid limit");
  }
  const normalized = Math.trunc(raw);
  if (normalized < min || normalized > max) {
    throw new Error(`Invalid limit (expected ${min}..${max})`);
  }
  return normalized;
}

async function handleToolCall(params: Record<string, unknown>, client: IpcClient, token: string): Promise<ToolCallResult> {
  const name = params.name;
  const argsRaw = params.arguments ?? {};

  if (typeof name !== "string" || !name.trim()) {
    return toToolCallError("Invalid tools/call: name is required");
  }

  let args: Record<string, unknown>;
  try {
    args = assertObject(argsRaw);
  } catch (err) {
    return toToolCallError(err instanceof Error ? err.message : "Invalid arguments");
  }

  try {
    if (name === "hiboss_agent_list") {
      const result = await client.call<AgentListResult>("agent.list", { token });
      const lines = result.agents.map((item, idx) => {
        const provider = item.provider ?? "claude";
        return `${idx + 1}. ${item.name} (${provider})`;
      });
      return {
        content: [{
          type: "text",
          text: lines.length > 0 ? lines.join("\n") : "No agents found.",
        }],
        structuredContent: { agents: result.agents },
      };
    }

    if (name === "hiboss_session_list") {
      const agentName = typeof args.agentName === "string" ? args.agentName.trim() : undefined;
      const limit = parseLimit(args.limit, 20, 1, 100);

      const result = await client.call<SessionListResult>("session.list", {
        token,
        ...(agentName ? { agentName } : {}),
        limit,
      });
      const lines = result.sessions.map((item, idx) => {
        const providerSession = item.providerSessionId ? ` provider-session=${item.providerSessionId}` : "";
        return `${idx + 1}. ${item.id} ${item.agentName} (${item.provider})${providerSession}`;
      });
      return {
        content: [{
          type: "text",
          text: lines.length > 0 ? lines.join("\n") : "No sessions found.",
        }],
        structuredContent: { sessions: result.sessions },
      };
    }

    if (name === "hiboss_envelope_send") {
      if (typeof args.to !== "string" || !args.to.trim()) {
        return toToolCallError("hiboss_envelope_send requires `to`.");
      }
      const parseMode = args.parseMode;
      if (
        parseMode !== undefined &&
        parseMode !== "plain" &&
        parseMode !== "markdownv2" &&
        parseMode !== "html"
      ) {
        return toToolCallError("Invalid parseMode (expected plain, markdownv2, or html).");
      }
      const toProvider = args.toProvider;
      if (toProvider !== undefined && toProvider !== "claude" && toProvider !== "codex") {
        return toToolCallError("Invalid toProvider (expected claude or codex).");
      }
      const interruptNow = args.interruptNow;
      if (interruptNow !== undefined && typeof interruptNow !== "boolean") {
        return toToolCallError("Invalid interruptNow (expected boolean).");
      }
      const text = args.text;
      if (text !== undefined && typeof text !== "string") {
        return toToolCallError("Invalid text (expected string).");
      }
      const deliverAt = args.deliverAt;
      if (deliverAt !== undefined && typeof deliverAt !== "string") {
        return toToolCallError("Invalid deliverAt (expected string).");
      }

      const result = await client.call<EnvelopeSendResult>("envelope.send", {
        token,
        to: args.to.trim(),
        origin: "mcp",
        ...(text !== undefined ? { text } : {}),
        ...(deliverAt !== undefined ? { deliverAt } : {}),
        ...(interruptNow !== undefined ? { interruptNow } : {}),
        ...(parseMode !== undefined ? { parseMode } : {}),
        ...(typeof args.replyToEnvelopeId === "string" && args.replyToEnvelopeId.trim()
          ? { replyToEnvelopeId: args.replyToEnvelopeId.trim() }
          : {}),
        ...(typeof args.toSessionId === "string" && args.toSessionId.trim()
          ? { toSessionId: args.toSessionId.trim() }
          : {}),
        ...(typeof args.toProviderSessionId === "string" && args.toProviderSessionId.trim()
          ? { toProviderSessionId: args.toProviderSessionId.trim() }
          : {}),
        ...(toProvider !== undefined ? { toProvider } : {}),
      });

      return {
        content: [{
          type: "text",
          text: result.interruptedWork === undefined
            ? `sent envelope: ${result.id}`
            : `sent envelope: ${result.id}; interruptedWork=${result.interruptedWork}; priorityApplied=${result.priorityApplied === true}`,
        }],
        structuredContent: result as Record<string, unknown>,
      };
    }

    if (name === "hiboss_envelope_list") {
      const status = args.status;
      if (status !== "pending" && status !== "done") {
        return toToolCallError("hiboss_envelope_list requires status: pending | done.");
      }
      const to = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
      const from = typeof args.from === "string" && args.from.trim() ? args.from.trim() : undefined;
      if ((to && from) || (!to && !from)) {
        return toToolCallError("Provide exactly one of to/from.");
      }
      const limit = parseLimit(args.limit, 10, 1, 50);
      if (args.createdAfter !== undefined && typeof args.createdAfter !== "string") {
        return toToolCallError("Invalid createdAfter (expected string).");
      }
      if (args.createdBefore !== undefined && typeof args.createdBefore !== "string") {
        return toToolCallError("Invalid createdBefore (expected string).");
      }

      const result = await client.call<EnvelopeListResult>("envelope.list", {
        token,
        status,
        ...(to ? { to } : {}),
        ...(from ? { from } : {}),
        limit,
        ...(typeof args.createdAfter === "string" ? { createdAfter: args.createdAfter } : {}),
        ...(typeof args.createdBefore === "string" ? { createdBefore: args.createdBefore } : {}),
      });
      const lines = result.envelopes.map((item, idx) => {
        const text = item.content.text?.trim() ? item.content.text.trim() : "(no-text)";
        return `${idx + 1}. ${item.id} ${item.from} -> ${item.to}: ${text}`;
      });
      return {
        content: [{
          type: "text",
          text: lines.length > 0 ? lines.join("\n") : "No envelopes found.",
        }],
        structuredContent: { envelopes: result.envelopes },
      };
    }
  } catch (err) {
    const e = err as Error & { code?: number; data?: unknown };
    return toToolCallError(e.message, e.data);
  }

  return toToolCallError(`Unknown tool: ${name}`);
}

function selectProtocolVersion(requested: unknown): string {
  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number])) {
    return requested;
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}

async function handleMcpRequest(
  request: JsonRpcRequest,
  client: IpcClient,
  token: string
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;
  const hasResponse = request.id !== undefined;

  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return hasResponse ? toProtocolError(id, -32600, "Invalid request") : null;
  }

  const method = request.method;
  const params = request.params ?? {};

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "initialize") {
    let paramsObj: Record<string, unknown>;
    try {
      paramsObj = assertObject(params);
    } catch {
      return toProtocolError(id, -32602, "Invalid params");
    }

    const protocolVersion = selectProtocolVersion(paramsObj.protocolVersion);
    if (!hasResponse) return null;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "hiboss",
          version: "1.0.0",
        },
      },
    };
  }

  if (method === "ping") {
    if (!hasResponse) return null;
    return {
      jsonrpc: "2.0",
      id,
      result: {},
    };
  }

  if (method === "tools/list") {
    if (!hasResponse) return null;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: MCP_TOOLS,
      },
    };
  }

  if (method === "tools/call") {
    let paramsObj: Record<string, unknown>;
    try {
      paramsObj = assertObject(params);
    } catch {
      return toProtocolError(id, -32602, "Invalid params");
    }

    const result = await handleToolCall(paramsObj, client, token);
    if (!hasResponse) return null;
    return {
      jsonrpc: "2.0",
      id,
      result,
    };
  }

  return hasResponse ? toProtocolError(id, -32601, `Method not found: ${method}`) : null;
}

export async function serveMcp(options: { token?: string }): Promise<void> {
  const token = resolveToken(options.token);
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      writeJsonLine(toProtocolError(null, -32700, "Parse error"));
      continue;
    }

    try {
      const response = await handleMcpRequest(request, client, token);
      if (response) {
        writeJsonLine(response);
      }
    } catch (err) {
      const e = err as Error;
      if (request.id !== undefined) {
        writeJsonLine(toProtocolError(request.id ?? null, -32603, e.message));
      }
    }
  }
}
