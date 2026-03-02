/**
 * Remove legacy agent-dm history chat directories.
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

function decodeHistoryDirName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function purgeLegacyInternalDmHistory(params: { agentsDir: string }): void {
  let removedChatDirs = 0;

  const agentDirs = listDirs(params.agentsDir);
  for (const agentDir of agentDirs) {
    const historyDir = path.join(agentDir, "internal_space", "history");
    if (!fs.existsSync(historyDir)) continue;

    const dateDirs = listDirs(historyDir).filter((fullPath) =>
      DATE_DIR_REGEX.test(path.basename(fullPath)),
    );

    for (const dateDir of dateDirs) {
      const chatDirs = listDirs(dateDir);
      for (const chatDir of chatDirs) {
        const decoded = decodeHistoryDirName(path.basename(chatDir));
        if (!decoded.startsWith("agent-dm:")) continue;
        try {
          fs.rmSync(chatDir, { recursive: true, force: true });
          removedChatDirs += 1;
        } catch (err) {
          logEvent("warn", "legacy-internal-dm-history-purge-failed", {
            path: chatDir,
            error: errorMessage(err),
          });
        }
      }
    }
  }

  if (removedChatDirs > 0) {
    logEvent("info", "legacy-internal-dm-history-purged", {
      "chat-dirs-removed": removedChatDirs,
    });
  }
}

