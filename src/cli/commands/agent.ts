import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import type { Agent } from "../../agent/types.js";
import type { AgentStatusResult } from "../../daemon/ipc/types.js";
import { formatUtcIsoAsLocalOffset } from "../../shared/time.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../shared/validation.js";
import { resolveToken } from "../token.js";
import { DEFAULT_AGENT_PERMISSION_LEVEL } from "../../shared/defaults.js";
import { normalizeDefaultSentinel, readMetadataInput, sanitizeAgentMetadata } from "./agent-shared.js";

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

interface AgentDeleteResult {
  success: boolean;
  agentName: string;
}

export interface RegisterAgentOptions {
  token?: string;
  name: string;
  description?: string;
  workspace?: string;
  provider?: string;
  providerSourceHome?: string;
  model?: string;
  reasoningEffort?: string;
  autoLevel?: string;
  permissionLevel?: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxContextLength?: number;
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

export interface DeleteAgentOptions {
  token?: string;
  name: string;
}

export interface AgentStatusOptions {
  token?: string;
  name: string;
}

function formatMsAsLocalOffset(ms: number): string {
  return formatUtcIsoAsLocalOffset(new Date(ms).toISOString());
}

export interface ListAgentsOptions {
  token?: string;
}

export interface SetAgentSessionPolicyOptions {
  token?: string;
  name: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxContextLength?: number;
  clear?: boolean;
}

export interface SetAgentOptions {
  token?: string;
  name: string;
  description?: string;
  workspace?: string;
  provider?: string;
  providerSourceHome?: string;
  model?: string;
  reasoningEffort?: string;
  autoLevel?: string;
  permissionLevel?: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxContextLength?: number;
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
    if (options.providerSourceHome && !options.provider) {
      throw new Error("--provider-source-home requires --provider");
    }

    const token = resolveToken(options.token);
    const reasoningEffort = normalizeDefaultSentinel(options.reasoningEffort);
    const result = await client.call<RegisterAgentResult>("agent.register", {
      token,
      name: options.name,
      description: options.description,
      workspace: options.workspace,
      provider: options.provider,
      providerSourceHome: options.providerSourceHome,
      model: options.model,
      reasoningEffort,
      autoLevel: options.autoLevel,
      permissionLevel: options.permissionLevel,
      metadata: sanitizeAgentMetadata(await readMetadataInput(options)),
      sessionDailyResetAt: options.sessionDailyResetAt,
      sessionIdleTimeout: options.sessionIdleTimeout,
      sessionMaxContextLength: options.sessionMaxContextLength,
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
    if (options.providerSourceHome && !options.provider) {
      throw new Error("--provider-source-home requires --provider");
    }

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
      : sanitizeAgentMetadata(await readMetadataInput(options)) ?? undefined;

    const sessionPolicy =
      options.clearSessionPolicy ||
      options.sessionDailyResetAt !== undefined ||
      options.sessionIdleTimeout !== undefined ||
      options.sessionMaxContextLength !== undefined
        ? options.clearSessionPolicy
          ? null
          : {
              dailyResetAt: options.sessionDailyResetAt,
              idleTimeout: options.sessionIdleTimeout,
              maxContextLength: options.sessionMaxContextLength,
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
      providerSourceHome: options.providerSourceHome,
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
      if (typeof sp.maxContextLength === "number") {
        console.log(`session-max-context-length: ${sp.maxContextLength}`);
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
      if (agent.model) {
        console.log(`model: ${agent.model}`);
      }
      if (agent.reasoningEffort) {
        console.log(`reasoning-effort: ${agent.reasoningEffort}`);
      }
      if (agent.sessionPolicy && typeof agent.sessionPolicy === "object") {
        if (typeof agent.sessionPolicy.dailyResetAt === "string") {
          console.log(`session-daily-reset-at: ${agent.sessionPolicy.dailyResetAt}`);
        }
        if (typeof agent.sessionPolicy.idleTimeout === "string") {
          console.log(`session-idle-timeout: ${agent.sessionPolicy.idleTimeout}`);
        }
        if (typeof agent.sessionPolicy.maxContextLength === "number") {
          console.log(`session-max-context-length: ${agent.sessionPolicy.maxContextLength}`);
        }
      }
      console.log(`created-at: ${formatUtcIsoAsLocalOffset(agent.createdAt)}`);
      console.log();
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

/**
 * Show runtime status for a single agent.
 */
export async function agentStatus(options: AgentStatusOptions): Promise<void> {
  if (!isValidAgentName(options.name)) {
    console.error("error:", AGENT_NAME_ERROR_MESSAGE);
    process.exit(1);
  }

  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const result = await client.call<AgentStatusResult>("agent.status", {
      token: resolveToken(options.token),
      agentName: options.name,
    });

    console.log(`name: ${result.agent.name}`);
    console.log(`workspace: ${result.effective.workspace}`);
    console.log(`provider: ${result.effective.provider}`);
    console.log(`model: ${result.agent.model ?? "default"}`);
    console.log(`reasoning-effort: ${result.agent.reasoningEffort ?? "default"}`);
    console.log(`auto-level: ${result.effective.autoLevel}`);
    console.log(`permission-level: ${result.effective.permissionLevel}`);
    if (result.bindings.length > 0) {
      console.log(`bindings: ${result.bindings.join(", ")}`);
    }
    console.log(`agent-state: ${result.status.agentState}`);
    console.log(`agent-health: ${result.status.agentHealth}`);
    console.log(`pending-count: ${result.status.pendingCount}`);

    if (result.status.currentRun) {
      console.log(`current-run-id: ${result.status.currentRun.id}`);
      console.log(
        `current-run-started-at: ${formatMsAsLocalOffset(result.status.currentRun.startedAt)}`
      );
    }

    if (!result.status.lastRun) {
      console.log("last-run-status: none");
      return;
    }

    console.log(`last-run-id: ${result.status.lastRun.id}`);
    console.log(`last-run-status: ${result.status.lastRun.status}`);
    console.log(`last-run-started-at: ${formatMsAsLocalOffset(result.status.lastRun.startedAt)}`);
    if (typeof result.status.lastRun.completedAt === "number") {
      console.log(
        `last-run-completed-at: ${formatMsAsLocalOffset(result.status.lastRun.completedAt)}`
      );
    }
    if (typeof result.status.lastRun.contextLength === "number") {
      console.log(`last-run-context-length: ${result.status.lastRun.contextLength}`);
    }
    if (result.status.lastRun.status === "failed" && result.status.lastRun.error) {
      console.log(`last-run-error: ${result.status.lastRun.error}`);
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

/**
 * Delete an agent.
 */
export async function deleteAgent(options: DeleteAgentOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const result = await client.call<AgentDeleteResult>("agent.delete", {
      token: resolveToken(options.token),
      agentName: options.name,
    });

    console.log(`success: ${result.success ? "true" : "false"}`);
    console.log(`agent-name: ${result.agentName}`);
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
        sessionMaxContextLength: options.sessionMaxContextLength,
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
      if (typeof sp.maxContextLength === "number") {
        console.log(`session-max-context-length: ${sp.maxContextLength}`);
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
