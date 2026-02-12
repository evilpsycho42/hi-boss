import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { resolveToken } from "../token.js";

interface ReactionSetResult {
  success: boolean;
}

export interface SetReactionOptions {
  token?: string;
  envelopeId: string;
  emoji: string;
}

export async function setReaction(options: SetReactionOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    if (!options.envelopeId || !options.envelopeId.trim()) {
      throw new Error("Missing --envelope-id");
    }
    if (!options.emoji || !options.emoji.trim()) {
      throw new Error("Missing --emoji");
    }

    const token = resolveToken(options.token);
    const result = await client.call<ReactionSetResult>("reaction.set", {
      token,
      envelopeId: options.envelopeId.trim(),
      emoji: options.emoji.trim(),
    });

    console.log(`success: ${result.success ? "true" : "false"}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}
