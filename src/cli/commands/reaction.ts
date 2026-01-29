import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { resolveToken } from "../token.js";

interface ReactionSetResult {
  success: boolean;
}

export interface SetReactionOptions {
  token?: string;
  to: string;
  messageId: string;
  emoji: string;
}

export async function setReaction(options: SetReactionOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<ReactionSetResult>("reaction.set", {
      token,
      to: options.to,
      messageId: options.messageId,
      emoji: options.emoji,
    });

    console.log(`success: ${result.success ? "true" : "false"}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

