import * as fs from "node:fs";
import * as path from "node:path";

import { assertValidTeamName } from "../shared/validation.js";

export function getTeamspacesDir(hibossDir: string): string {
  return path.join(hibossDir, "teamspaces");
}

export function getTeamspaceDir(teamName: string, hibossDir: string): string {
  assertValidTeamName(teamName);
  return path.join(getTeamspacesDir(hibossDir), teamName);
}

export function ensureTeamspaceDir(params: {
  hibossDir: string;
  teamName: string;
}): { ok: true; dir: string } | { ok: false; error: string } {
  try {
    const dir = getTeamspaceDir(params.teamName, params.hibossDir);
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true, dir };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function removeTeamspaceDir(params: {
  hibossDir: string;
  teamName: string;
}): { ok: true } | { ok: false; error: string } {
  try {
    const dir = getTeamspaceDir(params.teamName, params.hibossDir);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
