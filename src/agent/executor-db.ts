import type { HiBossDatabase } from "../daemon/db/database.js";

export function countDuePendingEnvelopesForAgent(db: HiBossDatabase, agentName: string): number {
  const rawDb = (db as any).db as { prepare?: (sql: string) => { get: (...args: any[]) => unknown } };
  if (!rawDb?.prepare) return 0;
  const sql =
    `SELECT COUNT(*) AS count FROM envelopes WHERE "to" = ? AND status = 'pending'` +
    ` AND (deliver_at IS NULL OR deliver_at <= ?)`;
  const row = rawDb.prepare(sql).get(`agent:${agentName}`, Date.now()) as { count: number } | undefined;
  return row?.count ?? 0;
}
