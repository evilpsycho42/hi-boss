import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import type { Agent } from "../../agent/types.js";
import { formatUtcIsoAsLocalOffset } from "../../shared/time.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../shared/validation.js";

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

interface BindAgentResult {
  binding: {
    id: string;
    agentName: string;
    adapterType: string;
    createdAt: string;
  };
}

export interface RegisterAgentOptions {
  name: string;
  description?: string;
  workspace?: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxTokens?: number;
}

export interface BindAgentOptions {
  name: string;
  adapterType: string;
  adapterToken: string;
}

export interface UnbindAgentOptions {
  name: string;
  adapterType: string;
}

export interface SetAgentSessionPolicyOptions {
  name: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxTokens?: number;
  clear?: boolean;
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

    const result = await client.call<RegisterAgentResult>("agent.register", {
      name: options.name,
      description: options.description,
      workspace: options.workspace,
      sessionDailyResetAt: options.sessionDailyResetAt,
      sessionIdleTimeout: options.sessionIdleTimeout,
      sessionMaxTokens: options.sessionMaxTokens,
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
 * List all agents.
 */
export async function listAgents(): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const result = await client.call<ListAgentsResult>("agent.list");

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
      const sessionPolicy = (agent.metadata as { sessionPolicy?: unknown } | undefined)
        ?.sessionPolicy as Record<string, unknown> | undefined;
      if (sessionPolicy && typeof sessionPolicy === "object") {
        if (typeof sessionPolicy.dailyResetAt === "string") {
          console.log(`session-daily-reset-at: ${sessionPolicy.dailyResetAt}`);
        }
        if (typeof sessionPolicy.idleTimeout === "string") {
          console.log(`session-idle-timeout: ${sessionPolicy.idleTimeout}`);
        }
        if (typeof sessionPolicy.maxTokens === "number") {
          console.log(`session-max-tokens: ${sessionPolicy.maxTokens}`);
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
    const result = await client.call<SetAgentSessionPolicyResult>(
      "agent.session-policy.set",
      {
        agentName: options.name,
        sessionDailyResetAt: options.sessionDailyResetAt,
        sessionIdleTimeout: options.sessionIdleTimeout,
        sessionMaxTokens: options.sessionMaxTokens,
        clear: options.clear,
      }
    );

    console.log(`agent-name: ${result.agentName}`);
    console.log(`success: ${result.success ? "true" : "false"}`);

    const sessionPolicy = result.sessionPolicy as Record<string, unknown> | undefined;
    if (sessionPolicy && typeof sessionPolicy === "object") {
      if (typeof sessionPolicy.dailyResetAt === "string") {
        console.log(`session-daily-reset-at: ${sessionPolicy.dailyResetAt}`);
      }
      if (typeof sessionPolicy.idleTimeout === "string") {
        console.log(`session-idle-timeout: ${sessionPolicy.idleTimeout}`);
      }
      if (typeof sessionPolicy.maxTokens === "number") {
        console.log(`session-max-tokens: ${sessionPolicy.maxTokens}`);
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
    const result = await client.call<BindAgentResult>("agent.bind", {
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
