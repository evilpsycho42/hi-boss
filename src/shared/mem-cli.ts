import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

export interface MemCliInitResult {
  ok: boolean;
  workspacePath?: string;
  migratedFrom?: string;
  error?: string;
}

export interface MemCliSummaryResult {
  ok: boolean;
  workspacePath?: string;
  summaryText?: string;
  error?: string;
}

const MAX_PROMPT_DAILY_DAYS = 2;

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function loadMemCliModules():
  | {
      workspace: {
        getPublicPath: () => string;
        resolveWorkspacePath: (options: { isPublic: boolean; token?: string }) => { path: string; type: "public" | "private"; tokenHash?: string };
        assertWorkspaceAccess: (ref: { path: string; type: "public" | "private"; tokenHash?: string }, token?: string) => unknown;
        initPublicWorkspace: () => string;
        initPrivateWorkspace: (token: string, customPath?: string) => string;
      };
      auth: {
        hashToken: (token: string) => string;
        tokenWorkspaceId: (tokenHash: string) => string;
      };
      registry: {
        readRegistry: () => Record<string, string | null>;
        writeRegistry: (registry: Record<string, string | null>) => unknown;
      };
      index: { openDb: (workspacePath: string) => { close: () => void } };
      layout: {
        WORKSPACE_DIRNAME: string;
        metaPath: (workspacePath: string) => string;
        dailyDirPath: (workspacePath: string) => string;
        findExistingLongMemoryPath: (workspacePath: string) => string | null;
      };
      settings: {
        ensureSettings: () => {
          summary: { days: number; maxChars: number; full: boolean };
        };
      };
    }
  | null {
  const require = createRequire(import.meta.url);
  try {
    const workspace = require("@kky42/mem-cli/dist/core/workspace");
    const auth = require("@kky42/mem-cli/dist/core/auth");
    const registry = require("@kky42/mem-cli/dist/core/registry");
    const index = require("@kky42/mem-cli/dist/core/index");
    const layout = require("@kky42/mem-cli/dist/core/layout");
    const settings = require("@kky42/mem-cli/dist/core/settings");
    return { workspace, auth, registry, index, layout, settings };
  } catch {
    return null;
  }
}

export function ensureMemCliPublicWorkspace(): MemCliInitResult {
  const mod = loadMemCliModules();
  if (!mod) {
    return { ok: false, error: "mem-cli is not installed (missing @kky42/mem-cli dependency)" };
  }

  try {
    const workspacePath = mod.workspace.getPublicPath();
    const metaPath = mod.layout.metaPath(workspacePath);
    if (!fs.existsSync(metaPath)) {
      mod.workspace.initPublicWorkspace();
    }
    const db = mod.index.openDb(workspacePath);
    db.close();
    return { ok: true, workspacePath };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

function resolveTokenWorkspaceId(mod: NonNullable<ReturnType<typeof loadMemCliModules>>, token: string): string {
  const tokenHash = mod.auth.hashToken(token);
  return mod.auth.tokenWorkspaceId(tokenHash);
}

function setPrivateRegistryPath(
  mod: NonNullable<ReturnType<typeof loadMemCliModules>>,
  token: string,
  workspacePath: string | null
): void {
  const workspaceId = resolveTokenWorkspaceId(mod, token);
  const registry = mod.registry.readRegistry();
  registry[workspaceId] = workspacePath;
  mod.registry.writeRegistry(registry);
}

function pathsEqual(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function tryMoveDir(from: string, to: string): { ok: boolean; error?: string } {
  try {
    fs.renameSync(from, to);
    return { ok: true };
  } catch (err) {
    const firstError = getErrorMessage(err);
    try {
      // Fallback for cross-device moves, etc.
      fs.cpSync(from, to, { recursive: true, errorOnExist: true });
      try {
        fs.rmSync(from, { recursive: true, force: true });
      } catch {}
      return { ok: true };
    } catch (err2) {
      return { ok: false, error: `${firstError}; copy fallback failed: ${getErrorMessage(err2)}` };
    }
  }
}

function normalizeCustomPath(customPath?: string): string | undefined {
  if (typeof customPath !== "string") return undefined;
  const trimmed = customPath.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function ensureMemCliPrivateWorkspace(token: string, customPath?: string): MemCliInitResult {
  const mod = loadMemCliModules();
  if (!mod) {
    return { ok: false, error: "mem-cli is not installed (missing @kky42/mem-cli dependency)" };
  }

  try {
    const desiredParent = normalizeCustomPath(customPath);
    const currentRef = mod.workspace.resolveWorkspacePath({ isPublic: false, token });
    const currentMetaPath = mod.layout.metaPath(currentRef.path);
    const currentHasMeta = fs.existsSync(currentMetaPath);

    let migratedFrom: string | undefined;

    if (desiredParent) {
      const desiredWorkspacePath = path.join(desiredParent, mod.layout.WORKSPACE_DIRNAME);
      const desiredMetaPath = mod.layout.metaPath(desiredWorkspacePath);
      const desiredHasMeta = fs.existsSync(desiredMetaPath);

      if (!pathsEqual(currentRef.path, desiredWorkspacePath)) {
        if (desiredHasMeta) {
          setPrivateRegistryPath(mod, token, desiredWorkspacePath);
        } else if (currentHasMeta) {
          // Try to move existing workspace data into the desired agent dir (best-effort).
          if (fs.existsSync(desiredWorkspacePath)) {
            const backup = `${desiredWorkspacePath}.bak-${Date.now()}`;
            try {
              fs.renameSync(desiredWorkspacePath, backup);
            } catch {}
          }

          const moved = tryMoveDir(currentRef.path, desiredWorkspacePath);
          if (!moved.ok) {
            // If migration fails, keep using the current workspace and don't clobber registry.
            mod.workspace.assertWorkspaceAccess(currentRef, token);
            const db = mod.index.openDb(currentRef.path);
            db.close();
            return { ok: true, workspacePath: currentRef.path };
          }

          migratedFrom = currentRef.path;
          setPrivateRegistryPath(mod, token, desiredWorkspacePath);
        } else {
          // Neither location is initialized; init in the desired agent dir.
          mod.workspace.initPrivateWorkspace(token, desiredParent);
        }
      } else if (!desiredHasMeta) {
        // Registry already points here but workspace isn't initialized yet.
        mod.workspace.initPrivateWorkspace(token, desiredParent);
      }
    } else if (!currentHasMeta) {
      // No explicit desired path. If resolveWorkspacePath already points at a custom dir, preserve it.
      const impliedParent = path.basename(currentRef.path) === mod.layout.WORKSPACE_DIRNAME
        ? path.dirname(currentRef.path)
        : undefined;
      mod.workspace.initPrivateWorkspace(token, impliedParent);
    } else {
      mod.workspace.assertWorkspaceAccess(currentRef, token);
    }

    const finalRef = mod.workspace.resolveWorkspacePath({ isPublic: false, token });
    mod.workspace.assertWorkspaceAccess(finalRef, token);
    const workspacePath = finalRef.path;
    const db = mod.index.openDb(workspacePath);
    db.close();
    return { ok: true, workspacePath, migratedFrom };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

function listRecentDailyFiles(dailyDir: string, days: number): string[] {
  if (!fs.existsSync(dailyDir)) {
    return [];
  }

  const files = fs
    .readdirSync(dailyDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort();

  if (files.length === 0) {
    return [];
  }

  const slice = days > 0 ? files.slice(-days) : [];
  return slice.map((name) => path.join(dailyDir, name));
}

function truncateMemory(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }

  const trimmed = content.slice(0, maxChars);
  return {
    content: `${trimmed}\n... <truncated due to max-chars=${maxChars}>`,
    truncated: true,
  };
}

export function getMemCliPrivateSummary(token: string, customPath?: string): MemCliSummaryResult {
  const mod = loadMemCliModules();
  if (!mod) {
    return { ok: false, error: "mem-cli is not installed (missing @kky42/mem-cli dependency)" };
  }

  const ensured = ensureMemCliPrivateWorkspace(token, customPath);
  if (!ensured.ok) {
    return { ok: false, error: ensured.error };
  }

  try {
    const ref = mod.workspace.resolveWorkspacePath({ isPublic: false, token });
    mod.workspace.assertWorkspaceAccess(ref, token);

    const memoryPath = mod.layout.findExistingLongMemoryPath(ref.path);
    const memoryRaw = memoryPath ? fs.readFileSync(memoryPath, "utf8") : "";

    const settings = mod.settings.ensureSettings();
    const days = Math.max(0, Math.min(settings.summary.days, MAX_PROMPT_DAILY_DAYS));
    const maxChars = settings.summary.maxChars;
    const useFull = settings.summary.full;

    const memory = useFull ? { content: memoryRaw, truncated: false } : truncateMemory(memoryRaw, maxChars);

    const dailyDir = mod.layout.dailyDirPath(ref.path);
    const dailyFiles = listRecentDailyFiles(dailyDir, days);
    const dailyLogs = dailyFiles.map((file) => ({
      file,
      content: fs.readFileSync(file, "utf8"),
    }));

    const parts: string[] = [];
    parts.push("# Summary");
    parts.push("");
    parts.push("## Long-term Memory");
    parts.push(memory.content.trim() || "(empty)");
    parts.push("");
    parts.push(`## Recent Daily Logs (last ${days} days)`);
    if (dailyLogs.length === 0) {
      parts.push("(none)");
    } else {
      for (const entry of dailyLogs) {
        parts.push(entry.content.trim());
        parts.push("");
      }
    }

    return { ok: true, workspacePath: ref.path, summaryText: parts.join("\n").trimEnd() };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}
