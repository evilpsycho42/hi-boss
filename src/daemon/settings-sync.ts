import type { HiBossDatabase } from "./db/database.js";
import {
  assertValidSettingsV3,
  readSettingsFile,
  type SettingsV3,
  withSettingsLock,
  writeSettingsFileAtomic,
} from "../shared/settings.js";

export function loadSettingsOrThrow(hibossDir: string): SettingsV3 {
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

export function syncSettingsToDb(db: HiBossDatabase, settings: SettingsV3): void {
  assertValidSettingsV3(settings);
  db.applySettingsSnapshot(settings);
}

export async function mutateSettingsAndSync(params: {
  hibossDir: string;
  db: HiBossDatabase;
  mutate: (settings: SettingsV3) => void;
}): Promise<SettingsV3> {
  return withSettingsLock(params.hibossDir, async () => {
    const current = loadSettingsOrThrow(params.hibossDir);
    const next = structuredClone(current);

    params.mutate(next);
    assertValidSettingsV3(next);

    await writeSettingsFileAtomic(params.hibossDir, next);

    try {
      syncSettingsToDb(params.db, next);
      return next;
    } catch (err) {
      await writeSettingsFileAtomic(params.hibossDir, current);
      syncSettingsToDb(params.db, current);
      throw err;
    }
  });
}
