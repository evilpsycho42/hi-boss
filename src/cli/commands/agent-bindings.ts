import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { formatUnixMsAsLocalOffset } from "../../shared/time.js";
import { resolveToken } from "../token.js";
import { formatShortId } from "../../shared/id-format.js";

interface BindAgentResult {
  binding: {
    id: string;
    agentName: string;
    adapterType: string;
    createdAt: number;
  };
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

    console.log(`id: ${formatShortId(result.binding.id)}`);
    console.log(`agent-name: ${result.binding.agentName}`);
    console.log(`adapter-type: ${result.binding.adapterType}`);
    console.log(`created-at: ${formatUnixMsAsLocalOffset(result.binding.createdAt)}`);
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
