import crypto from "node:crypto";
import http from "node:http";

type WebhookRoute = {
  secret?: string;
  onPayload: (payload: unknown) => Promise<void>;
};

function verifyWebhookSignature(
  secret: string,
  body: Buffer,
  timestamp: string,
  signature: string
): boolean {
  const h = crypto.createHmac("sha256", secret);
  h.update(timestamp);
  h.update(body);
  const expected = h.digest("hex");
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

export class WeChatPadProWebhookHub {
  private static server: http.Server | null = null;
  private static routes = new Map<string, WebhookRoute>();
  private static listenHost = "127.0.0.1";
  private static listenPort = 18080;
  private static started = false;

  static configure(host: string, port: number): void {
    if (this.started) return;
    this.listenHost = host;
    this.listenPort = port;
  }

  static async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.server = http.createServer((req, res) => void this.handleRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.listenPort, this.listenHost, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
    this.started = true;
  }

  static registerRoute(routePath: string, route: WebhookRoute): void {
    this.routes.set(routePath, route);
  }

  static unregisterRoute(routePath: string): void {
    this.routes.delete(routePath);
  }

  private static async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("method not allowed");
      return;
    }
    const reqUrl = req.url ?? "";
    const route = this.routes.get(reqUrl);
    if (!route) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(chunks);

    if (route.secret) {
      const ts = String(req.headers["x-webhook-timestamp"] ?? "");
      const sig = String(req.headers["x-webhook-signature"] ?? "");
      if (!ts || !sig || !verifyWebhookSignature(route.secret, body, ts, sig)) {
        res.statusCode = 401;
        res.end(JSON.stringify({ success: false, message: "signature verification failed" }));
        return;
      }
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, message: "invalid json" }));
      return;
    }

    try {
      await route.onPayload(payload);
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, message: err instanceof Error ? err.message : "internal error" }));
    }
  }
}
