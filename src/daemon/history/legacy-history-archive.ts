import * as fs from "node:fs";
import * as path from "node:path";

import { errorMessage, logEvent } from "../../shared/daemon-log.js";
import { SESSION_FILE_VERSION } from "./types.js";

const DATE_DIR_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function formatArchiveTimestamp(date: Date): string {
  const pad = (n: number, size = 2) => String(n).padStart(size, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    "-",
    pad(date.getUTCMilliseconds(), 3),
  ].join("");
}

function isLegacySessionFile(filePath: string): boolean {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const withVersion = parsed as { version?: unknown };
    if (withVersion.version === undefined) return false;
    return withVersion.version !== SESSION_FILE_VERSION;
  } catch {
    return false;
  }
}

function historyContainsLegacyHistory(historyDir: string): boolean {
  let dateDirs: string[];
  try {
    dateDirs = fs
      .readdirSync(historyDir)
      .filter((name) => DATE_DIR_REGEX.test(name))
      .sort()
      .reverse();
  } catch {
    return false;
  }

  for (const dateDir of dateDirs) {
    const dateDirPath = path.join(historyDir, dateDir);
    let files: string[];
    try {
      files = fs.readdirSync(dateDirPath).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      if (isLegacySessionFile(path.join(dateDirPath, file))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Move legacy history directories under HIBOSS_DIR/_archive.
 * This is intentionally destructive for active history location and is designed
 * for single-operator manual migration workflows.
 */
export function archiveLegacyHistory(params: { dataDir: string; agentsDir: string }): void {
  if (!fs.existsSync(params.agentsDir)) return;

  const archiveRoot = path.join(
    params.dataDir,
    "_archive",
    `history-legacy-${formatArchiveTimestamp(new Date())}`,
  );

  let entries: string[];
  try {
    entries = fs.readdirSync(params.agentsDir);
  } catch (err) {
    logEvent("warn", "history-archive-scan-failed", {
      "agents-dir": params.agentsDir,
      error: errorMessage(err),
    });
    return;
  }

  for (const agentName of entries) {
    const historyDir = path.join(params.agentsDir, agentName, "internal_space", "history");
    if (!fs.existsSync(historyDir)) continue;
    if (!historyContainsLegacyHistory(historyDir)) continue;

    const destination = path.join(archiveRoot, agentName, "history");
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(historyDir, destination);
      logEvent("info", "history-legacy-archived", {
        "agent-name": agentName,
        from: historyDir,
        to: destination,
      });
    } catch (err) {
      logEvent("warn", "history-legacy-archive-failed", {
        "agent-name": agentName,
        from: historyDir,
        to: destination,
        error: errorMessage(err),
      });
    }
  }
}
