import * as path from "node:path";

import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { resolveToken } from "../token.js";
import { resolveAndValidateMemoryModel } from "../memory-model.js";

interface MemoryAddResult {
  id: string;
}

interface MemorySearchResult {
  memories: Array<{
    id: string;
    text: string;
    category: string;
    createdAt: string;
    similarity?: number;
  }>;
}

interface MemoryListResult {
  memories: Array<{
    id: string;
    text: string;
    category: string;
    createdAt: string;
  }>;
}

interface MemoryCategoriesResult {
  categories: string[];
}

interface MemoryDeleteCategoryResult {
  ok: true;
  deleted: number;
}

interface MemoryGetResult {
  memory: {
    id: string;
    text: string;
    category: string;
    createdAt: string;
  } | null;
}

interface MemorySetupResult {
  memoryEnabled: boolean;
  modelPath: string;
  dims: number;
  lastError: string;
}

export interface MemoryAddOptions {
  token?: string;
  text: string;
  category?: string;
}

export interface MemorySearchOptions {
  token?: string;
  query: string;
  category?: string;
  limit?: number;
}

export interface MemoryListOptions {
  token?: string;
  category?: string;
  limit?: number;
}

export interface MemoryCategoriesOptions {
  token?: string;
}

export interface MemoryDeleteCategoryOptions {
  token?: string;
  category: string;
}

export interface MemoryGetOptions {
  token?: string;
  id: string;
}

export interface MemoryDeleteOptions {
  token?: string;
  id: string;
}

export interface MemoryClearOptions {
  token?: string;
}

export interface MemorySetupOptions {
  token?: string;
  default?: boolean;
  modelPath?: string;
}

function printMemoryItem(item: {
  id: string;
  category: string;
  createdAt: string;
  text: string;
  similarity?: number;
}): void {
  console.log(`id: ${item.id}`);
  console.log(`category: ${item.category}`);
  console.log(`created-at: ${item.createdAt}`);
  if (typeof item.similarity === "number") {
    console.log(`similarity: ${item.similarity}`);
  }
  console.log(`text-json: ${JSON.stringify(item.text)}`);
}

export async function memoryAdd(options: MemoryAddOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<MemoryAddResult>("memory.add", {
      token,
      text: options.text,
      category: options.category,
    });
    console.log(`id: ${result.id}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function memorySearch(options: MemorySearchOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<MemorySearchResult>("memory.search", {
      token,
      query: options.query,
      category: options.category,
      limit: options.limit,
    });

    console.log(`count: ${result.memories.length}`);
    for (const m of result.memories) {
      printMemoryItem(m);
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function memoryList(options: MemoryListOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<MemoryListResult>("memory.list", {
      token,
      category: options.category,
      limit: options.limit,
    });

    console.log(`count: ${result.memories.length}`);
    for (const m of result.memories) {
      printMemoryItem(m);
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function memoryCategories(options: MemoryCategoriesOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<MemoryCategoriesResult>("memory.categories", {
      token,
    });

    console.log(`count: ${result.categories.length}`);
    for (const category of result.categories) {
      console.log(`category: ${category}`);
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function memoryDeleteCategory(options: MemoryDeleteCategoryOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<MemoryDeleteCategoryResult>("memory.delete-category", {
      token,
      category: options.category,
    });

    console.log("ok: true");
    console.log(`deleted: ${result.deleted}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function memoryGet(options: MemoryGetOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<MemoryGetResult>("memory.get", {
      token,
      id: options.id,
    });

    if (!result.memory) {
      console.log("found: false");
      return;
    }

    console.log("found: true");
    printMemoryItem(result.memory);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function memoryDelete(options: MemoryDeleteOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    await client.call("memory.delete", {
      token,
      id: options.id,
    });
    console.log("ok: true");
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function memoryClear(options: MemoryClearOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    await client.call("memory.clear", {
      token,
    });
    console.log("ok: true");
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function memorySetup(options: MemorySetupOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);

    const wantsDefault = options.default === true;
    const wantsPath = typeof options.modelPath === "string" && options.modelPath.trim();
    if (wantsDefault && wantsPath) {
      throw new Error("Use either --default or --model-path, not both");
    }
    if (!wantsDefault && !wantsPath) {
      throw new Error("Use one of: --default OR --model-path <path>");
    }

    const memory =
      wantsDefault
        ? await resolveAndValidateMemoryModel({
            hibossDir: config.dataDir,
            mode: "default",
          })
        : await resolveAndValidateMemoryModel({
            hibossDir: config.dataDir,
            mode: "local",
            modelPath: path.resolve(process.cwd(), options.modelPath!.trim()),
          });

    const result = await client.call<MemorySetupResult>("memory.setup", {
      token,
      memory,
    });

    console.log(`memory-enabled: ${result.memoryEnabled ? "true" : "false"}`);
    console.log(`model-path: ${result.modelPath || "(none)"}`);
    console.log(`dims: ${result.dims}`);
    if (result.lastError) {
      console.log(`last-error: ${result.lastError}`);
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}
