import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { resolveToken } from "../token.js";

interface SetAgentSessionPolicyResult {
  success: boolean;
  agentName: string;
  sessionPolicy?: unknown;
}

export interface SetAgentSessionPolicyOptions {
  token?: string;
  name: string;
  sessionDailyResetAt?: string;
  sessionIdleTimeout?: string;
  sessionMaxContextLength?: number;
  clear?: boolean;
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

