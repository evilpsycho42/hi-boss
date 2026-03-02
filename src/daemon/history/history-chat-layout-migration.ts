import * as fs from "node:fs";
import * as path from "node:path";

import { errorMessage, logEvent } from "../../shared/daemon-log.js";
import { readSessionFile } from "./session-file-io.js";
import {
  DEFAULT_HISTORY_CHAT_DIR,
  inferSessionChatId,
  normalizeHistoryChatDir,
} from "./chat-scope-path.js";

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

function safeMove(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
}

function reserveArchivePath(basePath: string): string {
  if (!fs.existsSync(basePath)) return basePath;
  for (let i = 1; i <= 1000; i += 1) {
    const next = `${basePath}.dup${i}`;
    if (!fs.existsSync(next)) return next;
  }
  return `${basePath}.dup-overflow-${Date.now()}`;
}

/**
 * Migrate session history layout from:
 *   history/YYYY-MM-DD/<session-id>.json
 * to:
 *   history/YYYY-MM-DD/<chat-id>/<session-id>.json
 *
 * If a file cannot be moved into the new layout safely, archive it into:
 *   {{HIBOSS_DIR}}/_archive/history-chat-layout-<timestamp>/...
 */
export function migrateHistoryChatLayout(params: { dataDir: string; agentsDir: string }): void {
  if (!fs.existsSync(params.agentsDir)) return;

  const archiveRoot = path.join(
    params.dataDir,
    "_archive",
    `history-chat-layout-${formatArchiveTimestamp(new Date())}`,
  );

  let moved = 0;
  let archived = 0;

  let agentNames: string[] = [];
  try {
    agentNames = fs.readdirSync(params.agentsDir);
  } catch (err) {
    logEvent("warn", "history-chat-layout-migration-scan-failed", {
      "agents-dir": params.agentsDir,
      error: errorMessage(err),
    });
    return;
  }

  for (const agentName of agentNames) {
    const historyDir = path.join(params.agentsDir, agentName, "internal_space", "history");
    if (!fs.existsSync(historyDir)) continue;

    let dateDirs: string[] = [];
    try {
      dateDirs = fs
        .readdirSync(historyDir)
        .filter((name) => DATE_DIR_REGEX.test(name))
        .sort();
    } catch {
      continue;
    }

    for (const dateDir of dateDirs) {
      const dateDirPath = path.join(historyDir, dateDir);

      let entries: string[] = [];
      try {
        entries = fs.readdirSync(dateDirPath);
      } catch {
        continue;
      }

      for (const entryName of entries) {
        if (!entryName.endsWith(".json")) continue;
        const legacyPath = path.join(dateDirPath, entryName);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(legacyPath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;

        const session = readSessionFile(legacyPath);
        const inferredChatId = session ? inferSessionChatId(session) : null;
        const chatDir = normalizeHistoryChatDir(inferredChatId);
        const targetPath = path.join(dateDirPath, chatDir, entryName);

        if (targetPath === legacyPath) continue;

        try {
          if (fs.existsSync(targetPath)) {
            throw new Error(`target exists: ${targetPath}`);
          }
          safeMove(legacyPath, targetPath);
          moved += 1;
        } catch (err) {
          const archivePath = reserveArchivePath(
            path.join(archiveRoot, agentName, "history", dateDir, DEFAULT_HISTORY_CHAT_DIR, entryName),
          );
          try {
            safeMove(legacyPath, archivePath);
            archived += 1;
            logEvent("warn", "history-chat-layout-migration-archived", {
              "agent-name": agentName,
              from: legacyPath,
              to: archivePath,
              reason: errorMessage(err),
            });
          } catch (archiveErr) {
            logEvent("warn", "history-chat-layout-migration-failed", {
              "agent-name": agentName,
              from: legacyPath,
              to: targetPath,
              error: errorMessage(archiveErr),
              reason: errorMessage(err),
            });
          }
        }
      }
    }
  }

  if (moved > 0 || archived > 0) {
    logEvent("info", "history-chat-layout-migrated", {
      "files-moved": moved,
      "files-archived": archived,
    });
  }
}
