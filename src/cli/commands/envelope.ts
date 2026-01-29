import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { resolveToken } from "../token.js";
import type { Envelope } from "../../envelope/types.js";
import { formatEnvelopeInstruction } from "../instructions/format-envelope.js";
import { buildTurnInput } from "../../agent/turn-input.js";
import * as fs from "fs";
import * as path from "path";

interface SendEnvelopeResult {
  id: string;
}

interface ListEnvelopesResult {
  envelopes: Envelope[];
}

interface TurnPreviewResult {
  agentName: string;
  datetimeIso: string;
  envelopes: Envelope[];
}

interface GetEnvelopeResult {
  envelope: Envelope;
}

export interface SendEnvelopeOptions {
  from?: string;
  to: string;
  token?: string;
  fromBoss?: boolean;
  fromName?: string;
  text?: string;
  textFile?: string;
  attachment?: string[];
  deliverAt?: string;
}

export interface ListEnvelopesOptions {
  token?: string;
  address?: string;
  box?: "inbox" | "outbox";
  status?: "pending" | "done";
  limit?: number;
  asTurn?: boolean;
}

export interface GetEnvelopeOptions {
  id: string;
  token?: string;
}


function isProbablyFilePath(value: string): boolean {
  if (value.startsWith("./") || value.startsWith("../")) return true;
  if (value.includes("/") || value.includes("\\")) return true;
  return path.extname(value) !== "";
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizeAttachmentSource(source: string): string {
  if (source.startsWith("telegram:file-id:")) return source;
  if (looksLikeUrl(source)) return source;
  if (path.isAbsolute(source)) return source;

  const resolved = path.resolve(process.cwd(), source);
  if (fs.existsSync(resolved)) return resolved;
  if (isProbablyFilePath(source)) return resolved;
  return source;
}

/**
 * Process escape sequences in CLI text input.
 * Converts literal \n, \t, and \\ to actual characters.
 */
function processEscapeSequences(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

/**
 * Read text from stdin.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  let result = Buffer.concat(chunks).toString("utf-8");
  // Strip at most one trailing newline (preserve intentional whitespace)
  if (result.endsWith("\n")) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Read text from a file.
 */
async function readFileText(filePath: string): Promise<string> {
  let result = await fs.promises.readFile(filePath, "utf-8");
  // Strip at most one trailing newline (consistent with stdin)
  if (result.endsWith("\n")) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Resolve text from --text or --text-file options.
 * Priority: --text (direct) > --text - (stdin) > --text-file
 */
async function resolveText(
  text?: string,
  textFile?: string
): Promise<string | undefined> {
  const textIsStdin = text === "-";
  const fileIsStdin = textFile === "-";

  // Conflict: --text (non-stdin) and --text-file both provided
  if (text && !textIsStdin && textFile) {
    throw new Error("Cannot use both --text and --text-file");
  }

  // Conflict: both pointing to stdin
  if (textIsStdin && fileIsStdin) {
    throw new Error("Cannot use --text - and --text-file - together");
  }

  // Priority 1: Direct text (non-stdin)
  if (text && !textIsStdin) {
    return processEscapeSequences(text);
  }

  // Priority 2: Stdin (--text - or --text-file -)
  if (textIsStdin || fileIsStdin) {
    return readStdin();
  }

  // Priority 3: File
  if (textFile) {
    return readFileText(textFile);
  }

  return undefined;
}

/**
 * Send an envelope.
 */
export async function sendEnvelope(options: SendEnvelopeOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const text = await resolveText(options.text, options.textFile);
    const result = await client.call<SendEnvelopeResult>("envelope.send", {
      token,
      from: options.from,
      to: options.to,
      fromBoss: options.fromBoss,
      fromName: options.fromName,
      text,
      attachments: options.attachment?.map((source) => ({
        source: normalizeAttachmentSource(source),
      })),
      deliverAt: options.deliverAt,
    });

    console.log(`id: ${result.id}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

/**
 * List envelopes.
 */
export async function listEnvelopes(options: ListEnvelopesOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);

    if (options.asTurn) {
      if (options.box !== undefined && options.box !== "inbox") {
        throw new Error("--as-turn requires --box inbox");
      }
      if (options.status !== undefined && options.status !== "pending") {
        throw new Error("--as-turn requires --status pending");
      }

      let agentName: string | undefined;
      if (options.address !== undefined) {
        const trimmed = options.address.trim();
        if (!trimmed.startsWith("agent:")) {
          throw new Error("--as-turn requires --address agent:<name> (boss token only)");
        }
        agentName = trimmed.slice("agent:".length);
      }

      const result = await client.call<TurnPreviewResult>("turn.preview", {
        token,
        agentName,
        limit: options.limit,
      });

      console.log(
        buildTurnInput({
          context: { datetime: result.datetimeIso, agentName: result.agentName },
          envelopes: result.envelopes,
        })
      );
      return;
    }

    const result = await client.call<ListEnvelopesResult>("envelope.list", {
      token,
      address: options.address,
      box: options.box,
      status: options.status,
      limit: options.limit,
    });

    if (result.envelopes.length === 0) {
      console.log("no-envelopes: true");
      return;
    }

    for (const env of result.envelopes) {
      console.log(formatEnvelopeInstruction(env));
      console.log();
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

/**
 * Get an envelope by ID.
 */
export async function getEnvelope(options: GetEnvelopeOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<GetEnvelopeResult>("envelope.get", {
      token,
      id: options.id,
    });

    console.log(formatEnvelopeInstruction(result.envelope));
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}
