import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  RpcMethodRegistry,
} from "./types.js";
import { RPC_ERRORS } from "./types.js";

async function isSocketAcceptingConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const socket = net.createConnection({ path: socketPath });

    const finish = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), 200);

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Unix Domain Socket JSON-RPC 2.0 server.
 */
export class IpcServer {
  private server: net.Server | null = null;
  private methods: RpcMethodRegistry = {};

  constructor(private socketPath: string) {}

  /**
   * Register an RPC method handler.
   */
  registerMethod(name: string, handler: RpcMethodRegistry[string]): void {
    this.methods[name] = handler;
  }

  /**
   * Register multiple RPC method handlers.
   */
  registerMethods(methods: RpcMethodRegistry): void {
    Object.assign(this.methods, methods);
  }

  /**
   * Start the IPC server.
   */
  async start(): Promise<void> {
    // Ensure directory exists
    const dir = path.dirname(this.socketPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Only unlink the socket if it's stale. If another daemon is running,
    // the socket will accept connections and we must NOT steal it.
    if (fs.existsSync(this.socketPath)) {
      const inUse = await isSocketAcceptingConnections(this.socketPath);
      if (inUse) {
        throw new Error("Daemon is already running");
      }
      fs.unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));

      this.server.on("error", reject);

      this.server.listen(this.socketPath, () => {
        // Set socket permissions (owner only)
        fs.chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
  }

  /**
   * Stop the IPC server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          if (fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = "";

    socket.on("data", async (data) => {
      buffer += data.toString();

      // Process complete messages (newline-delimited)
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim()) {
          const response = await this.processRequest(line);
          socket.write(JSON.stringify(response) + "\n");
        }
      }
    });

    socket.on("error", (err) => {
      console.error("[IPC] Socket error:", err.message);
    });
  }

  private async processRequest(data: string): Promise<JsonRpcResponse> {
    let request: JsonRpcRequest;

    try {
      request = JSON.parse(data);
    } catch {
      return {
        jsonrpc: "2.0",
        id: 0,
        error: {
          code: RPC_ERRORS.PARSE_ERROR,
          message: "Parse error",
        },
      };
    }

    // Validate request
    if (
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string" ||
      request.id === undefined
    ) {
      return {
        jsonrpc: "2.0",
        id: request.id ?? 0,
        error: {
          code: RPC_ERRORS.INVALID_REQUEST,
          message: "Invalid request",
        },
      };
    }

    // Find method handler
    const handler = this.methods[request.method];
    if (!handler) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: RPC_ERRORS.METHOD_NOT_FOUND,
          message: `Method not found: ${request.method}`,
        },
      };
    }

    // Execute method
    try {
      const result = await handler(request.params ?? {});
      return {
        jsonrpc: "2.0",
        id: request.id,
        result,
      };
    } catch (err) {
      const error = err as Error & { code?: number; data?: unknown };
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: error.code ?? RPC_ERRORS.INTERNAL_ERROR,
          message: error.message,
          data: error.data,
        },
      };
    }
  }
}
