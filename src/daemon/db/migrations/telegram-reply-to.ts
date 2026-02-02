import type Database from "better-sqlite3";
import { formatTelegramMessageIdCompact } from "../../../shared/telegram-message-id.js";

function tableExists(db: Database.Database, table: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.length > 0;
}

function migrateTelegramReplyToMessageIdsInTable(params: {
  db: Database.Database;
  table: "envelopes" | "cron_schedules";
  idColumn: string;
  toColumn: string;
}): void {
  const { db, table, idColumn, toColumn } = params;

  const rows = db.prepare(`
    SELECT ${idColumn} AS id, metadata, ${toColumn} AS to_address
    FROM ${table}
    WHERE metadata IS NOT NULL
      AND ${toColumn} LIKE 'channel:telegram:%'
  `).all() as Array<{ id: string; metadata: string; to_address: string }>;

  if (rows.length === 0) return;

  const update = db.prepare(`UPDATE ${table} SET metadata = ? WHERE ${idColumn} = ?`);

  for (const row of rows) {
    let md: unknown;
    try {
      md = JSON.parse(row.metadata);
    } catch {
      continue;
    }
    if (typeof md !== "object" || md === null) continue;

    const obj = md as Record<string, unknown>;
    const replyToRaw = obj.replyToMessageId;
    if (typeof replyToRaw !== "string") continue;

    const trimmed = replyToRaw.trim();
    if (!trimmed) continue;

    // Old versions stored telegram reply-to ids as plain decimal, or as "tg<base36>".
    if (/^\d+$/.test(trimmed)) {
      obj.replyToMessageId = formatTelegramMessageIdCompact(trimmed);
    } else {
      const m = /^tg[:\-]?([0-9a-z]+)$/i.exec(trimmed);
      if (!m) continue;
      obj.replyToMessageId = m[1].toLowerCase();
    }

    try {
      update.run(JSON.stringify(obj), row.id);
    } catch {
      // Best-effort migration; ignore row-level failures.
    }
  }
}

/**
 * Migrate telegram reply-to-channel-message-id values stored as decimal strings into the compact base36 form.
 *
 * This prevents older stored values like "1001" from being misinterpreted now that Telegram message ids
 * are handled as base36 by default.
 */
export function migrateTelegramReplyToMessageIdsToBase36(db: Database.Database): void {
  if (tableExists(db, "envelopes")) {
    migrateTelegramReplyToMessageIdsInTable({
      db,
      table: "envelopes",
      idColumn: "id",
      toColumn: "\"to\"",
    });
  }

  if (tableExists(db, "cron_schedules")) {
    migrateTelegramReplyToMessageIdsInTable({
      db,
      table: "cron_schedules",
      idColumn: "id",
      toColumn: "to_address",
    });
  }
}
