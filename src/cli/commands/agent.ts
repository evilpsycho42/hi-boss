import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import type { Agent } from "../../agent/types.js";
import { formatUtcIsoAsLocalOffset } from "../../shared/time.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../shared/validation.js";
import { resolveToken } from "../token.js";
import * as path from "path";
import * as fs from "fs";
import { DEFAULT_AGENT_PERMISSION_LEVEL } from "../../shared/defaults.js";

interface RegisterAgentResult {
  agent: Omit<Agent, "token">;
  token: string;
}

interface AgentWithBindings extends Omit<Agent, "token"> {
  bindings: string[];
}

interface ListAgentsResult {
  agents: AgentWithBindings[];
}

interface AgentSetResult {
  success: boolean;
  agent: Omit<Agent, "token"> & {
    permissionLevel?: string;
  };
  bindings: string[];
}

interface BindAgentResult {
  binding: {
    id: string;
    agentName: string;
    adapterType: string;
    createdAt: string;
  };
}

export interface RegisterAgentOptions {
  token?: string;
  name: string;
  description?: string;
  workspace?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  autoLevel?: string;
  permissionLevel?: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxTokens?: number;
  metadataJson?: string;
  metadataFile?: string;
  bindAdapterType?: string;
  bindAdapterToken?: string;
}

export interface BindAgentOptions {
  token?: string;
  name: string;
  adapterType: string;
  adapterToken: string;
}

export interface UnbindAgentOptions {
  token?: string;
  name: string;
  adapterType: string;
}

export interface ListAgentsOptions {
  token?: string;
}

export interface SetAgentSessionPolicyOptions {
  token?: string;
  name: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxTokens?: number;
  clear?: boolean;
}

export interface SetAgentOptions {
  token?: string;
  name: string;
  description?: string;
  workspace?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  autoLevel?: string;
  permissionLevel?: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxTokens?: number;
  clearSessionPolicy?: boolean;
  metadataJson?: string;
  metadataFile?: string;
  clearMetadata?: boolean;
  bindAdapterType?: string;
  bindAdapterToken?: string;
  unbindAdapterType?: string;
}

interface SetAgentSessionPolicyResult {
  success: boolean;
  agentName: string;
  sessionPolicy?: unknown;
}

async function readMetadataInput(options: {
  metadataJson?: string;
  metadataFile?: string;
}): Promise<Record<string, unknown> | undefined> {
  const jsonInline = options.metadataJson?.trim();
  const filePath = options.metadataFile?.trim();

  if (jsonInline && filePath) {
    throw new Error("Use only one of --metadata-json or --metadata-file");
  }

  if (jsonInline) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonInline);
    } catch {
      throw new Error("Invalid metadata JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Invalid metadata JSON (expected object)");
    }
    return parsed as Record<string, unknown>;
  }

  if (filePath) {
    const abs = path.resolve(process.cwd(), filePath);
    const json = await fs.promises.readFile(abs, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("Invalid metadata file JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Invalid metadata file JSON (expected object)");
    }
    return parsed as Record<string, unknown>;
  }

  return undefined;
}

/**
 * Register a new agent.
 */
export async function registerAgent(options: RegisterAgentOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    if (!isValidAgentName(options.name)) {
      throw new Error(AGENT_NAME_ERROR_MESSAGE);
    }

    const token = resolveToken(options.token);
    const result = await client.call<RegisterAgentResult>("agent.register", {
      token,
      name: options.name,
      description: options.description,
      workspace: options.workspace,
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      autoLevel: options.autoLevel,
      permissionLevel: options.permissionLevel,
      metadata: await readMetadataInput(options),
      sessionDailyResetAt: options.sessionDailyResetAt,
      sessionIdleTimeout: options.sessionIdleTimeout,
      sessionMaxTokens: options.sessionMaxTokens,
      bindAdapterType: options.bindAdapterType,
      bindAdapterToken: options.bindAdapterToken,
    });

    console.log(`name: ${result.agent.name}`);
    if (result.agent.description) {
      console.log(`description: ${result.agent.description}`);
    }
    if (result.agent.workspace) {
      console.log(`workspace: ${result.agent.workspace}`);
    }
    console.log(`token: ${result.token}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

/**
 * Update agent settings and bindings.
 */
export async function setAgent(options: SetAgentOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);

    if (options.clearMetadata && (options.metadataJson || options.metadataFile)) {
      throw new Error("Use either --clear-metadata or --metadata-json/--metadata-file, not both");
    }
    if (
      (options.bindAdapterType && !options.bindAdapterToken) ||
      (!options.bindAdapterType && options.bindAdapterToken)
    ) {
      throw new Error("--bind-adapter-type and --bind-adapter-token must be used together");
    }
    if (options.unbindAdapterType && options.bindAdapterType) {
      throw new Error("Use either --bind-adapter-* or --unbind-adapter-type, not both");
    }

    const metadata = options.clearMetadata
      ? null
      : (await readMetadataInput(options)) ?? undefined;

    const sessionPolicy =
      options.clearSessionPolicy ||
      options.sessionDailyResetAt !== undefined ||
      options.sessionIdleTimeout !== undefined ||
      options.sessionMaxTokens !== undefined
        ? options.clearSessionPolicy
          ? null
          : {
              dailyResetAt: options.sessionDailyResetAt,
              idleTimeout: options.sessionIdleTimeout,
              maxTokens: options.sessionMaxTokens,
            }
      : undefined;

    const model = normalizeDefaultSentinel(options.model);
    const reasoningEffort = normalizeDefaultSentinel(options.reasoningEffort);

    const result = await client.call<AgentSetResult>("agent.set", {
      token,
      agentName: options.name,
      description: options.description,
      workspace: options.workspace,
      provider: options.provider,
      model,
      reasoningEffort,
      autoLevel: options.autoLevel,
      permissionLevel: options.permissionLevel,
      sessionPolicy,
      metadata,
      bindAdapterType: options.bindAdapterType,
      bindAdapterToken: options.bindAdapterToken,
      unbindAdapterType: options.unbindAdapterType,
    });

    console.log(`success: ${result.success ? "true" : "false"}`);
    console.log(`agent-name: ${result.agent.name}`);
    if (result.agent.description) {
      console.log(`description: ${result.agent.description}`);
    }
    if (result.agent.workspace) {
      console.log(`workspace: ${result.agent.workspace}`);
    }
    if (result.agent.provider) {
      console.log(`provider: ${result.agent.provider}`);
    }
    if (result.agent.model) {
      console.log(`model: ${result.agent.model}`);
    }
    if (result.agent.reasoningEffort) {
      console.log(`reasoning-effort: ${result.agent.reasoningEffort}`);
    }
    if (result.agent.autoLevel) {
      console.log(`auto-level: ${result.agent.autoLevel}`);
    }
    if (result.agent.permissionLevel) {
      console.log(`permission-level: ${result.agent.permissionLevel}`);
    }
    if (result.agent.sessionPolicy && typeof result.agent.sessionPolicy === "object") {
      const sp = result.agent.sessionPolicy as Record<string, unknown>;
      if (typeof sp.dailyResetAt === "string") {
        console.log(`session-daily-reset-at: ${sp.dailyResetAt}`);
      }
      if (typeof sp.idleTimeout === "string") {
        console.log(`session-idle-timeout: ${sp.idleTimeout}`);
      }
      if (typeof sp.maxTokens === "number") {
        console.log(`session-max-tokens: ${sp.maxTokens}`);
      }
    }
    if (result.bindings.length > 0) {
      console.log(`bindings: ${result.bindings.join(", ")}`);
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

function normalizeDefaultSentinel(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "provider_default") {
    throw new Error("Invalid value 'provider_default' (use 'default' to clear and use provider defaults)");
  }
  if (trimmed === "default") return null;
  return trimmed;
}

/**
 * List all agents.
 */
export async function listAgents(options: ListAgentsOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const result = await client.call<ListAgentsResult>("agent.list", {
      token: resolveToken(options.token),
    });

    if (result.agents.length === 0) {
      console.log("no-agents: true");
      return;
    }

    for (const agent of result.agents) {
      console.log(`name: ${agent.name}`);
      if (agent.description) {
        console.log(`description: ${agent.description}`);
      }
      if (agent.workspace) {
        console.log(`workspace: ${agent.workspace}`);
      }
      if (agent.provider) {
        console.log(`provider: ${agent.provider}`);
      }
      if (agent.model) {
        console.log(`model: ${agent.model}`);
      }
      if (agent.reasoningEffort) {
        console.log(`reasoning-effort: ${agent.reasoningEffort}`);
      }
      if (agent.autoLevel) {
        console.log(`auto-level: ${agent.autoLevel}`);
      }
      if (agent.permissionLevel) {
        console.log(`permission-level: ${agent.permissionLevel}`);
      }
      if (agent.sessionPolicy && typeof agent.sessionPolicy === "object") {
        if (typeof agent.sessionPolicy.dailyResetAt === "string") {
          console.log(`session-daily-reset-at: ${agent.sessionPolicy.dailyResetAt}`);
        }
        if (typeof agent.sessionPolicy.idleTimeout === "string") {
          console.log(`session-idle-timeout: ${agent.sessionPolicy.idleTimeout}`);
        }
        if (typeof agent.sessionPolicy.maxTokens === "number") {
          console.log(`session-max-tokens: ${agent.sessionPolicy.maxTokens}`);
        }
      }
      if (agent.bindings && agent.bindings.length > 0) {
        console.log(`bindings: ${agent.bindings.join(", ")}`);
      }
      console.log(`created-at: ${formatUtcIsoAsLocalOffset(agent.createdAt)}`);
      if (agent.lastSeenAt) {
        console.log(`last-seen-at: ${formatUtcIsoAsLocalOffset(agent.lastSeenAt)}`);
      }
      console.log();
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

/**
 * Set an agent's session policy.
 */
export async function setAgentSessionPolicy(
  options: SetAgentSessionPolicyOptions
): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<SetAgentSessionPolicyResult>(
      "agent.session-policy.set",
      {
        token,
        agentName: options.name,
        sessionDailyResetAt: options.sessionDailyResetAt,
        sessionIdleTimeout: options.sessionIdleTimeout,
        sessionMaxTokens: options.sessionMaxTokens,
        clear: options.clear,
      }
    );

    console.log(`agent-name: ${result.agentName}`);
    console.log(`success: ${result.success ? "true" : "false"}`);

    const sessionPolicy = result.sessionPolicy;
    if (sessionPolicy && typeof sessionPolicy === "object") {
      const sp = sessionPolicy as Record<string, unknown>;
      if (typeof sp.dailyResetAt === "string") {
        console.log(`session-daily-reset-at: ${sp.dailyResetAt}`);
      }
      if (typeof sp.idleTimeout === "string") {
        console.log(`session-idle-timeout: ${sp.idleTimeout}`);
      }
      if (typeof sp.maxTokens === "number") {
        console.log(`session-max-tokens: ${sp.maxTokens}`);
      }
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

/**
 * Bind an adapter to an agent.
 */
export async function bindAgent(options: BindAgentOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<BindAgentResult>("agent.bind", {
      token,
      agentName: options.name,
      adapterType: options.adapterType,
      adapterToken: options.adapterToken,
    });

    console.log(`id: ${result.binding.id}`);
    console.log(`agent-name: ${result.binding.agentName}`);
    console.log(`adapter-type: ${result.binding.adapterType}`);
    console.log(`created-at: ${formatUtcIsoAsLocalOffset(result.binding.createdAt)}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

/**
 * Unbind an adapter from an agent.
 */
export async function unbindAgent(options: UnbindAgentOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    await client.call("agent.unbind", {
      token: resolveToken(options.token),
      agentName: options.name,
      adapterType: options.adapterType,
    });

    console.log(`agent-name: ${options.name}`);
    console.log(`adapter-type: ${options.adapterType}`);
    console.log("unbound: true");
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}
