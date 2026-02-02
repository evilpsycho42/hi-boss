import * as fs from "fs";
import * as path from "path";

export async function readMetadataInput(options: {
  metadataJson?: string;
  metadataFile?: string;
}): Promise<Record<string, unknown> | undefined> {
  const jsonInline = options.metadataJson?.trim();
  const filePath = options.metadataFile?.trim();

  if (jsonInline && filePath) {
    throw new Error("Use only one of --metadata-json or --metadata-file");
  }

  if (jsonInline) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonInline);
    } catch {
      throw new Error("Invalid metadata JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Invalid metadata JSON (expected object)");
    }
    return parsed as Record<string, unknown>;
  }

  if (filePath) {
    const abs = path.resolve(process.cwd(), filePath);
    const json = await fs.promises.readFile(abs, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("Invalid metadata file JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Invalid metadata file JSON (expected object)");
    }
    return parsed as Record<string, unknown>;
  }

  return undefined;
}

export function normalizeDefaultSentinel(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "provider_default") {
    throw new Error("Invalid value 'provider_default' (use 'default' to clear and use provider defaults)");
  }
  if (trimmed === "default") return null;
  return trimmed;
}

