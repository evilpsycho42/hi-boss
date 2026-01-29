import * as net from "net";
import type { JsonRpcRequest, JsonRpcResponse } from "../daemon/ipc/types.js";

/**
 * IPC client for communicating with the Hi-Boss daemon.
 */
export class IpcClient {
  private requestId = 0;

  constructor(private socketPath: string) {}

  /**
   * Call an RPC method on the daemon.
   */
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      params,
    };

    const response = await this.sendRequest(request);

    if (response.error) {
      const err = new Error(response.error.message) as Error & {
        code: number;
        data?: unknown;
      };
      err.code = response.error.code;
      err.data = response.error.data;
      throw err;
    }

    return response.result as T;
  }

  private sendRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";

      socket.on("connect", () => {
        socket.write(JSON.stringify(request) + "\n");
      });

      socket.on("data", (data) => {
        buffer += data.toString();

        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          try {
            const response = JSON.parse(line) as JsonRpcResponse;
            socket.end();
            resolve(response);
          } catch (err) {
            socket.end();
            reject(new Error("Invalid response from daemon"));
          }
        }
      });

      socket.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("Daemon is not running. Start it with: hiboss daemon start"));
        } else if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
          reject(new Error("Cannot connect to daemon. Try restarting it."));
        } else {
          reject(err);
        }
      });

      socket.on("timeout", () => {
        socket.end();
        reject(new Error("Request timed out"));
      });

      socket.setTimeout(30000);
    });
  }
}
