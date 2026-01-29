import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import type { Agent } from "../../agent/types.js";
import { formatUtcIsoAsLocalOffset } from "../../shared/time.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../../shared/validation.js";
import { authorizeCliOperation } from "../authz.js";
import { resolveToken } from "../token.js";
import { HiBossDatabase } from "../../daemon/db/database.js";
import * as path from "path";

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
  token?: string;
  name: string;
  description?: string;
  workspace?: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxTokens?: number;
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

export interface SetAgentPermissionLevelOptions {
  token?: string;
  name: string;
  permissionLevel: string;
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

    const token = resolveToken(options.token);
    const result = await client.call<RegisterAgentResult>("agent.register", {
      token,
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
      const permissionLevel = (agent.metadata as { permissionLevel?: unknown } | undefined)
        ?.permissionLevel;
      if (
        permissionLevel === "restricted" ||
        permissionLevel === "standard" ||
        permissionLevel === "privileged"
      ) {
        console.log(`permission-level: ${permissionLevel}`);
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

function getDbPath(): string {
  const config = getDefaultConfig();
  return path.join(config.dataDir, "hiboss.db");
}

export async function setAgentPermissionLevel(
  options: SetAgentPermissionLevelOptions
): Promise<void> {
  try {
    const token = resolveToken(options.token);
    authorizeCliOperation("agent.permission.set", token);

    if (
      options.permissionLevel !== "restricted" &&
      options.permissionLevel !== "standard" &&
      options.permissionLevel !== "privileged"
    ) {
      throw new Error("Invalid permission-level (expected restricted, standard, privileged)");
    }

    const db = new HiBossDatabase(getDbPath());
    try {
      const result = db.setAgentPermissionLevel(options.name, options.permissionLevel);
      console.log(`success: ${result.success ? "true" : "false"}`);
      console.log(`agent-name: ${result.agentName}`);
      console.log(`permission-level: ${result.permissionLevel}`);
    } finally {
      db.close();
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}
