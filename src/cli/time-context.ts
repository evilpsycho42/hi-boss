import type { IpcClient } from "./ipc-client.js";
import type { DaemonTimeResult } from "../daemon/ipc/types.js";

export async function getDaemonTimeContext(params: {
  client: IpcClient;
  token: string;
}): Promise<DaemonTimeResult> {
  return params.client.call<DaemonTimeResult>("daemon.time", { token: params.token });
}

