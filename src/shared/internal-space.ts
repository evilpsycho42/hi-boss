import * as fs from "node:fs";
import * as path from "node:path";

import { DEFAULT_INTERNAL_SPACE_NOTE_MAX_CHARS } from "./defaults.js";
import { assertValidAgentName } from "./validation.js";

const NOTE_FILENAME = "Note.md";

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getAgentInternalSpaceDir(hibossDir: string, agentName: string): string {
  return path.join(hibossDir, "agents", agentName, "internal_space");
}

function getAgentNotePath(hibossDir: string, agentName: string): string {
  return path.join(getAgentInternalSpaceDir(hibossDir, agentName), NOTE_FILENAME);
}

function truncateWithMarker(input: string, maxChars: number, marker: string): string {
  if (input.length <= maxChars) return input;
  const trimmed = input.slice(0, maxChars);
  return `${trimmed}\n\n${marker}`;
}

export function ensureAgentInternalSpaceLayout(params: {
  hibossDir: string;
  agentName: string;
}): { ok: true } | { ok: false; error: string } {
  try {
    assertValidAgentName(params.agentName);

    const dir = getAgentInternalSpaceDir(params.hibossDir, params.agentName);
    const notePath = getAgentNotePath(params.hibossDir, params.agentName);

    fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(notePath)) {
      fs.writeFileSync(notePath, "", "utf8");
    } else {
      const stat = fs.statSync(notePath);
      if (!stat.isFile()) {
        return { ok: false, error: `Expected file at ${notePath}` };
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

export function readAgentInternalNoteSnapshot(params: {
  hibossDir: string;
  agentName: string;
}):
  | { ok: true; note: string }
  | { ok: false; error: string } {
  try {
    assertValidAgentName(params.agentName);

    const notePath = getAgentNotePath(params.hibossDir, params.agentName);

    let raw = "";
    if (fs.existsSync(notePath)) {
      const stat = fs.statSync(notePath);
      if (stat.isFile()) {
        raw = fs.readFileSync(notePath, "utf8");
      }
    }

    const note = truncateWithMarker(
      raw.trim(),
      DEFAULT_INTERNAL_SPACE_NOTE_MAX_CHARS,
      `<<truncated due to internal-space-note-max-chars=${DEFAULT_INTERNAL_SPACE_NOTE_MAX_CHARS}>>`
    );

    return { ok: true, note };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

