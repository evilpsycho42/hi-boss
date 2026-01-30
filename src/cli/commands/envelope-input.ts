import * as fs from "fs";
import * as path from "path";

function isProbablyFilePath(value: string): boolean {
  if (value.startsWith("./") || value.startsWith("../")) return true;
  if (value.includes("/") || value.includes("\\")) return true;
  return path.extname(value) !== "";
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function normalizeAttachmentSource(source: string): string {
  if (source.startsWith("telegram:file-id:")) return source;
  if (looksLikeUrl(source)) return source;
  if (path.isAbsolute(source)) return source;

  const resolved = path.resolve(process.cwd(), source);
  if (fs.existsSync(resolved)) return resolved;
  if (isProbablyFilePath(source)) return resolved;
  return source;
}

export function extractTelegramFileId(source: string): string | undefined {
  const prefix = "telegram:file-id:";
  if (!source.startsWith(prefix)) return undefined;
  const id = source.slice(prefix.length).trim();
  return id ? id : undefined;
}

/**
 * Process escape sequences in CLI text input.
 * Converts literal \n, \t, and \\ to actual characters.
 */
function processEscapeSequences(text: string): string {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
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
export async function resolveText(
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

