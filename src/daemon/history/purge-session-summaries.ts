/**
 * Remove legacy `summary` fields from session history files.
 *
 * This migration is idempotent and safe to run at daemon startup.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { errorMessage, logEvent } from "../../shared/daemon-log.js";

const DATE_DIR_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function listDirs(parent: string): string[] {
  try {
    return fs
      .readdirSync(parent)
      .map((name) => path.join(parent, name))
      .filter((fullPath) => {
        try {
          return fs.statSync(fullPath).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function purgeSessionSummaryFields(params: { agentsDir: string }): void {
  let scanned = 0;
  let cleaned = 0;

  const agentDirs = listDirs(params.agentsDir);
  for (const agentDir of agentDirs) {
    const historyDir = path.join(agentDir, "internal_space", "history");
    if (!fs.existsSync(historyDir)) continue;

    const dateDirs = listDirs(historyDir).filter((fullPath) =>
      DATE_DIR_REGEX.test(path.basename(fullPath)),
    );

    for (const dateDir of dateDirs) {
      const files = listDateSessionFiles(dateDir);

      for (const filePath of files) {
        scanned += 1;
        try {
          const raw = fs.readFileSync(filePath, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (!isRecord(parsed)) continue;
          if (!Object.prototype.hasOwnProperty.call(parsed, "summary")) continue;

          delete parsed.summary;
          const tmpPath = `${filePath}.tmp`;
          fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), "utf8");
          fs.renameSync(tmpPath, filePath);
          cleaned += 1;
        } catch (err) {
          logEvent("warn", "session-summary-purge-file-failed", {
            path: filePath,
            error: errorMessage(err),
          });
        }
      }
    }
  }

  if (cleaned > 0) {
    logEvent("info", "session-summary-purged", {
      "files-scanned": scanned,
      "files-cleaned": cleaned,
    });
  }
}

function listDateSessionFiles(dateDir: string): string[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dateDir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dateDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entryPath);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;

    let subEntries: string[] = [];
    try {
      subEntries = fs.readdirSync(entryPath);
    } catch {
      continue;
    }
    for (const subEntry of subEntries) {
      if (!subEntry.endsWith(".json")) continue;
      const subPath = path.join(entryPath, subEntry);
      try {
        if (fs.statSync(subPath).isFile()) {
          files.push(subPath);
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return files;
}
