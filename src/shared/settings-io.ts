import * as fs from "node:fs";
import * as path from "node:path";
import * as lockfile from "proper-lockfile";

import {
  parseSettingsJson,
  SETTINGS_FILENAME,
  SETTINGS_FILE_MODE,
  stringifySettings,
  type Settings,
} from "./settings.js";

export function getSettingsPath(hibossDir: string): string {
  return path.join(hibossDir, SETTINGS_FILENAME);
}

export function ensureSettingsFileMode(filePath: string): void {
  try {
    fs.chmodSync(filePath, SETTINGS_FILE_MODE);
  } catch {
    // Best-effort across platforms.
  }
}

/**
 * Intentionally synchronous: used in startup/command paths, not hot loops.
 */
export function readSettingsFile(hibossDir: string): Settings {
  const settingsPath = getSettingsPath(hibossDir);
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Settings file not found: ${settingsPath}`);
  }
  const json = fs.readFileSync(settingsPath, "utf8");
  const settings = parseSettingsJson(json);
  ensureSettingsFileMode(settingsPath);
  return settings;
}

export async function writeSettingsFileAtomic(hibossDir: string, settings: Settings): Promise<void> {
  const settingsPath = getSettingsPath(hibossDir);
  const tmpPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  const json = stringifySettings(settings);

  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  try {
    await fs.promises.writeFile(tmpPath, json, {
      encoding: "utf8",
      mode: SETTINGS_FILE_MODE,
    });
    await fs.promises.rename(tmpPath, settingsPath);
    ensureSettingsFileMode(settingsPath);
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export async function withSettingsLock<T>(hibossDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${getSettingsPath(hibossDir)}.lock`;
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  if (!fs.existsSync(lockPath)) {
    fs.writeFileSync(lockPath, "", { encoding: "utf8", mode: SETTINGS_FILE_MODE });
  }

  const release = await lockfile.lock(lockPath, {
    stale: 10000,
    update: 5000,
    retries: {
      retries: 10,
      minTimeout: 50,
      maxTimeout: 300,
    },
  });

  try {
    return await fn();
  } finally {
    await release().catch(() => undefined);
  }
}
