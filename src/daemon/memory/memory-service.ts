import * as path from "node:path";
import { randomUUID } from "node:crypto";

import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Schema, Utf8 } from "apache-arrow";
import { getLlama, type LlamaEmbeddingContext, type LlamaModel } from "node-llama-cpp";

import { assertValidAgentName } from "../../shared/validation.js";
import { embedTextForExamples } from "../../shared/examples-memory-embed.js";

export interface MemoryResult {
  id: string;
  text: string;
  category: string;
  createdAt: number; // unix epoch ms (UTC)
  similarity?: number;
}

type MemoryRow = Record<string, unknown> & {
  id: string;
  text: string;
  vector: number[];
  category: string;
  createdAt: string; // stored as string for Arrow Utf8 compatibility
};

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

function normalizeVector(vector: readonly number[]): number[] {
  let sumSquares = 0;
  for (const x of vector) {
    sumSquares += x * x;
  }
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm <= 0) {
    return Array.from(vector);
  }
  return Array.from(vector, (x) => x / norm);
}

export class MemoryService {
  private db!: lancedb.Connection;
  private model: LlamaModel | null = null;
  private embeddingContext: LlamaEmbeddingContext | null = null;
  private dims!: number;
  private schema!: Schema;
  private tables: Map<string, lancedb.Table> = new Map();
  private embeddingMode: "llama" | "examples" = "llama";

  private embeddingQueue: Promise<unknown> = Promise.resolve();

  private constructor() {}

  static async create(params: {
    dataDir: string;
    modelPath: string;
    dims?: number;
    mode?: "default" | "examples";
  }): Promise<MemoryService> {
    const modelPath = params.modelPath.trim();
    if (!modelPath) {
      throw new Error("Invalid memory model path");
    }

    const daemonMode = (process.env.HIBOSS_DAEMON_MODE ?? "").trim().toLowerCase();
    const examplesMode = params.mode === "examples" || daemonMode === "examples";
    if (examplesMode) {
      const dims = params.dims ?? 0;
      if (!Number.isFinite(dims) || dims <= 0) {
        throw new Error("Missing memory model dims (examples mode)");
      }

      const db = await lancedb.connect(path.join(params.dataDir, "memory.lance"));
      const service = new MemoryService();
      service.db = db;
      service.embeddingMode = "examples";
      service.dims = Math.trunc(dims);
      service.schema = new Schema([
        new Field("id", new Utf8(), false),
        new Field("text", new Utf8(), false),
        new Field(
          "vector",
          new FixedSizeList(service.dims, new Field("item", new Float32(), false)),
          false
        ),
        new Field("category", new Utf8(), false),
        new Field("createdAt", new Utf8(), false),
      ]);
      return service;
    }

    let db: lancedb.Connection | null = null;
    let model: LlamaModel | null = null;
    let embeddingContext: LlamaEmbeddingContext | null = null;

    try {
      db = await lancedb.connect(path.join(params.dataDir, "memory.lance"));

      const llama = await getLlama({ gpu: "auto" });
      model = await llama.loadModel({
        modelPath,
        gpuLayers: "auto",
      });

      const dims = model.embeddingVectorSize;
      if (!Number.isFinite(dims) || dims <= 0) {
        throw new Error("Invalid embedding vector size from model");
      }

      embeddingContext = await model.createEmbeddingContext({
        contextSize: "auto",
      });

      const service = new MemoryService();
      service.db = db;
      service.model = model;
      service.embeddingContext = embeddingContext;
      service.embeddingMode = "llama";
      service.dims = Math.trunc(dims);
      service.schema = new Schema([
        new Field("id", new Utf8(), false),
        new Field("text", new Utf8(), false),
        new Field(
          "vector",
          new FixedSizeList(service.dims, new Field("item", new Float32(), false)),
          false
        ),
        new Field("category", new Utf8(), false),
        new Field("createdAt", new Utf8(), false),
      ]);
      return service;
    } catch (err) {
      await embeddingContext?.dispose().catch(() => undefined);
      await model?.dispose().catch(() => undefined);
      db?.close();
      throw err;
    }
  }

  private async getTable(agentName: string): Promise<lancedb.Table> {
    assertValidAgentName(agentName);

    const cached = this.tables.get(agentName);
    if (cached) return cached;

    const tableName = `memories__${toSafeAgentTableSuffix(agentName)}`;
    const existing = await this.db.tableNames();
    const table = existing.includes(tableName)
      ? await this.db.openTable(tableName)
      : await this.db.createEmptyTable(tableName, this.schema);

    this.tables.set(agentName, table);
    return table;
  }

  private enqueueEmbedding<T>(task: () => Promise<T>): Promise<T> {
    const next = this.embeddingQueue.then(task, task) as Promise<T>;
    this.embeddingQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async embedText(text: string): Promise<number[]> {
    return this.enqueueEmbedding(async () => {
      if (this.embeddingMode === "examples") {
        return embedTextForExamples(text, this.dims);
      }
      if (!this.embeddingContext) {
        throw new Error("Memory embedding context not initialized");
      }
      const emb = await this.embeddingContext.getEmbeddingFor(text);
      return normalizeVector(emb.vector);
    });
  }

  async add(
    agentName: string,
    text: string,
    opts?: { category?: string }
  ): Promise<string> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Invalid text");
    }

    const table = await this.getTable(agentName);
    const id = randomUUID();
    const category = (opts?.category ?? "fact").trim() || "fact";
    const createdAt = String(Date.now());
    const vector = await this.embedText(trimmed);

    const row: MemoryRow = {
      id,
      text: trimmed,
      vector,
      category,
      createdAt,
    };

    await table.add([row]);
    return id;
  }

  async search(
    agentName: string,
    query: string,
    opts?: { category?: string; limit?: number }
  ): Promise<MemoryResult[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new Error("Invalid query");
    }

    const table = await this.getTable(agentName);
    const queryVector = await this.embedText(trimmed);

    let q = table
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .select(["id", "text", "category", "createdAt", "_distance"]);

    if (opts?.category && opts.category.trim()) {
      const c = escapeSqlStringLiteral(opts.category.trim());
      q = q.where(`category = '${c}'`);
    }

    const limit = opts?.limit ?? 5;
    const rows = await q.limit(limit).toArray();

    return rows.map((r) => {
      const distance = typeof r._distance === "number" ? r._distance : undefined;
      const similarity =
        typeof distance === "number"
          ? Math.max(-1, Math.min(1, 1 - distance))
          : undefined;

      return {
        id: String(r.id),
        text: String(r.text),
        category: String(r.category),
        createdAt: parseUnixMs((r as Record<string, unknown>).createdAt),
        similarity,
      };
    });
  }

  async list(
    agentName: string,
    opts?: { category?: string; limit?: number }
  ): Promise<MemoryResult[]> {
    const table = await this.getTable(agentName);

    let q = table.query().select(["id", "text", "category", "createdAt"]);
    if (opts?.category && opts.category.trim()) {
      const c = escapeSqlStringLiteral(opts.category.trim());
      q = q.where(`category = '${c}'`);
    }

    const limit = opts?.limit ?? 100;
    const rows = await q.toArray();

    const results: MemoryResult[] = rows.map((r) => ({
      id: String(r.id),
      text: String(r.text),
      category: String(r.category),
      createdAt: parseUnixMs((r as Record<string, unknown>).createdAt),
    }));

    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(0, limit);
  }

  async get(agentName: string, id: string): Promise<MemoryResult | null> {
    const trimmed = id.trim();
    if (!trimmed) throw new Error("Invalid id");

    const table = await this.getTable(agentName);
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

  async categories(agentName: string): Promise<string[]> {
    const table = await this.getTable(agentName);
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

    const table = await this.getTable(agentName);
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

    const table = await this.getTable(agentName);
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
    await this.embeddingContext?.dispose().catch(() => undefined);
    await this.model?.dispose().catch(() => undefined);
    this.db.close();
  }
}
