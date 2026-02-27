import type { HiBossDatabase } from "./db/database.js";
import { logEvent } from "../shared/daemon-log.js";
import { readSettingsFile, withSettingsLock, writeSettingsFileAtomic } from "../shared/settings-io.js";
import {
  assertValidSettings,
  type Settings,
} from "../shared/settings.js";

export function loadSettingsOrThrow(hibossDir: string): Settings {
  try {
    return readSettingsFile(hibossDir);
  } catch (err) {
    const message = (err as Error).message;
    throw new Error(
      [
        `Failed to load settings.json: ${message}`,
        "Run `hiboss setup` to generate settings, then restart the daemon.",
      ].join("\n")
    );
  }
}

export function syncSettingsToDb(db: HiBossDatabase, settings: Settings): void {
  assertValidSettings(settings);
  db.applySettingsSnapshot(settings);
}

export async function mutateSettingsAndSync(params: {
  hibossDir: string;
  db: HiBossDatabase;
  mutate: (settings: Settings) => void;
}): Promise<Settings> {
  return withSettingsLock(params.hibossDir, async () => {
    const current = loadSettingsOrThrow(params.hibossDir);
    const next = structuredClone(current);

    params.mutate(next);
    assertValidSettings(next);

    await writeSettingsFileAtomic(params.hibossDir, next);

    try {
      syncSettingsToDb(params.db, next);
      return next;
    } catch (err) {
      const originalError = err as Error;

      try {
        await writeSettingsFileAtomic(params.hibossDir, current);
      } catch (rollbackFileError) {
        logEvent("error", "settings-sync-rollback-file-failed", {
          "hiboss-dir": params.hibossDir,
          "original-error": originalError.message,
          "rollback-error": (rollbackFileError as Error).message,
        });
      }

      try {
        syncSettingsToDb(params.db, current);
      } catch (rollbackDbError) {
        logEvent("error", "settings-sync-rollback-db-failed", {
          "hiboss-dir": params.hibossDir,
          "original-error": originalError.message,
          "rollback-error": (rollbackDbError as Error).message,
          "state-note": "settings-file-and-db-cache-may-be-inconsistent",
        });
      }

      throw originalError;
    }
  });
}
