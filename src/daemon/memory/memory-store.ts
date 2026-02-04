import * as path from "node:path";

import * as lancedb from "@lancedb/lancedb";

import { assertValidAgentName } from "../../shared/validation.js";
import { compactUuid } from "../../shared/id-format.js";
import type { MemoryResult } from "./memory-service.js";

function toSafeAgentTableSuffix(agentName: string): string {
  return agentName.replace(/-/g, "_");
}

function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function parseUnixMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const asString = typeof value === "string" ? value : String(value ?? "");
  const n = Number(asString);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

export class MemoryStore {
  private db!: lancedb.Connection;
  private tables: Map<string, lancedb.Table> = new Map();

  private constructor() {}

  static async create(params: { dataDir: string }): Promise<MemoryStore> {
    const store = new MemoryStore();
    store.db = await lancedb.connect(path.join(params.dataDir, "memory.lance"));
    return store;
  }

  private async getExistingTable(agentName: string): Promise<lancedb.Table | null> {
    assertValidAgentName(agentName);

    const cached = this.tables.get(agentName);
    if (cached) return cached;

    const tableName = `memories__${toSafeAgentTableSuffix(agentName)}`;
    const existing = await this.db.tableNames();
    if (!existing.includes(tableName)) return null;

    const table = await this.db.openTable(tableName);
    this.tables.set(agentName, table);
    return table;
  }

  async list(
    agentName: string,
    opts?: { category?: string; limit?: number }
  ): Promise<MemoryResult[]> {
    const table = await this.getExistingTable(agentName);
    if (!table) return [];

    let q = table.query().select(["id", "text", "category", "createdAt"]);
    if (opts?.category && opts.category.trim()) {
      const c = escapeSqlStringLiteral(opts.category.trim());
      q = q.where(`category = '${c}'`);
    }

    const rows = await q.toArray();
    const results: MemoryResult[] = rows.map((r) => ({
      id: String((r as Record<string, unknown>).id),
      text: String((r as Record<string, unknown>).text),
      category: String((r as Record<string, unknown>).category),
      createdAt: parseUnixMs((r as Record<string, unknown>).createdAt),
    }));

    results.sort((a, b) => b.createdAt - a.createdAt);
    const limit = opts?.limit ?? 100;
    return results.slice(0, limit);
  }

  async get(agentName: string, id: string): Promise<MemoryResult | null> {
    const trimmed = id.trim();
    if (!trimmed) throw new Error("Invalid id");

    const table = await this.getExistingTable(agentName);
    if (!table) return null;

    const safeId = escapeSqlStringLiteral(trimmed);
    const rows = await table
      .query()
      .select(["id", "text", "category", "createdAt"])
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray();
    if (rows.length === 0) return null;

    const r = rows[0] as Record<string, unknown>;
    return {
      id: String(r.id),
      text: String(r.text),
      category: String(r.category),
      createdAt: parseUnixMs(r.createdAt),
    };
  }

  async findByIdPrefix(agentName: string, compactIdPrefix: string): Promise<MemoryResult[]> {
    const prefix = compactIdPrefix.trim().toLowerCase();
    if (!prefix) return [];

    const table = await this.getExistingTable(agentName);
    if (!table) return [];

    const rows = await table.query().select(["id", "text", "category", "createdAt"]).toArray();
    const matches: MemoryResult[] = [];
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const id = String(r.id ?? "");
      if (!id) continue;
      if (!compactUuid(id).startsWith(prefix)) continue;
      matches.push({
        id,
        text: String(r.text ?? ""),
        category: String(r.category ?? ""),
        createdAt: parseUnixMs(r.createdAt),
      });
    }

    matches.sort((a, b) => b.createdAt - a.createdAt);
    return matches;
  }

  async categories(agentName: string): Promise<string[]> {
    const table = await this.getExistingTable(agentName);
    if (!table) return [];

    const rows = await table.query().select(["category"]).toArray();
    const seen = new Set<string>();
    for (const r of rows) {
      const category = String((r as Record<string, unknown>).category ?? "").trim();
      if (category) seen.add(category);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }

  async deleteCategory(agentName: string, category: string): Promise<number> {
    const trimmed = category.trim();
    if (!trimmed) throw new Error("Invalid category");

    const table = await this.getExistingTable(agentName);
    if (!table) return 0;

    const c = escapeSqlStringLiteral(trimmed);
    const predicate = `category = '${c}'`;

    const deleted = await table.countRows(predicate);
    if (deleted > 0) {
      await table.delete(predicate);
    }
    return deleted;
  }

  async delete(agentName: string, id: string): Promise<void> {
    const trimmed = id.trim();
    if (!trimmed) throw new Error("Invalid id");

    const table = await this.getExistingTable(agentName);
    if (!table) return;

    const safeId = escapeSqlStringLiteral(trimmed);
    await table.delete(`id = '${safeId}'`);
  }

  async clear(agentName: string): Promise<void> {
    assertValidAgentName(agentName);
    const tableName = `memories__${toSafeAgentTableSuffix(agentName)}`;
    const existing = await this.db.tableNames();
    if (existing.includes(tableName)) {
      await this.db.dropTable(tableName);
    }
    this.tables.delete(agentName);
  }

  async close(): Promise<void> {
    this.tables.clear();
    this.db.close();
  }
}
