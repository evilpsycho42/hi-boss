import * as fs from "node:fs";
import * as path from "node:path";

import { getLlama, resolveModelFile } from "node-llama-cpp";

import {
  DEFAULT_MEMORY_MODEL_URL,
  DEFAULT_MODELS_DIRNAME,
} from "../shared/defaults.js";

export type MemoryModelMode = "default" | "local";

export interface ResolvedMemoryModelConfig {
  enabled: boolean;
  mode: MemoryModelMode;
  modelPath: string;
  modelUri: string;
  dims: number;
  lastError: string;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function validateEmbeddingModel(modelPath: string): Promise<number> {
  const llama = await getLlama({ gpu: "auto" });
  const model = await llama.loadModel({
    modelPath,
    gpuLayers: "auto",
  });

  let embeddingContext: Awaited<ReturnType<typeof model.createEmbeddingContext>> | null = null;
  try {
    const dims = model.embeddingVectorSize;
    if (!Number.isFinite(dims) || dims <= 0) {
      throw new Error("Invalid embedding vector size from model");
    }

    embeddingContext = await model.createEmbeddingContext({
      contextSize: "auto",
    });

    const test = await embeddingContext.getEmbeddingFor("ping");
    if (!Array.isArray(test.vector) || test.vector.length !== dims) {
      throw new Error("Embedding vector size mismatch");
    }

    return Math.trunc(dims);
  } finally {
    await embeddingContext?.dispose().catch(() => undefined);
    await model.dispose().catch(() => undefined);
  }
}

export async function resolveAndValidateMemoryModel(params: {
  daemonDir: string;
  mode: MemoryModelMode;
  modelPath?: string;
}): Promise<ResolvedMemoryModelConfig> {
  const daemonDir = params.daemonDir.trim();
  const mode = params.mode;

  if (!daemonDir) {
    return {
      enabled: false,
      mode,
      modelPath: "",
      modelUri: "",
      dims: 0,
      lastError: "Invalid daemonDir",
    };
  }

  if (mode === "default") {
    const modelUri = DEFAULT_MEMORY_MODEL_URL;
    const modelsDir = path.join(daemonDir, DEFAULT_MODELS_DIRNAME);
    ensureDir(modelsDir);

    try {
      const modelPath = await resolveModelFile(modelUri, {
        directory: modelsDir,
        download: "auto",
        verify: false,
        cli: true,
      });

      const dims = await validateEmbeddingModel(modelPath);

      return {
        enabled: true,
        mode,
        modelPath,
        modelUri,
        dims,
        lastError: "",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        enabled: false,
        mode,
        modelPath: "",
        modelUri,
        dims: 0,
        lastError: message,
      };
    }
  }

  // mode === "local"
  const rawPath = params.modelPath ?? "";
  const modelPath = rawPath.trim();
  if (!modelPath) {
    return {
      enabled: false,
      mode,
      modelPath: "",
      modelUri: "",
      dims: 0,
      lastError: "Model path is required",
    };
  }
  if (!path.isAbsolute(modelPath)) {
    return {
      enabled: false,
      mode,
      modelPath,
      modelUri: "",
      dims: 0,
      lastError: "Model path must be an absolute path",
    };
  }
  if (!fs.existsSync(modelPath)) {
    return {
      enabled: false,
      mode,
      modelPath,
      modelUri: "",
      dims: 0,
      lastError: `Model file not found: ${modelPath}`,
    };
  }
  const stat = fs.statSync(modelPath);
  if (!stat.isFile()) {
    return {
      enabled: false,
      mode,
      modelPath,
      modelUri: "",
      dims: 0,
      lastError: `Expected file at: ${modelPath}`,
    };
  }

  try {
    const dims = await validateEmbeddingModel(modelPath);
    return {
      enabled: true,
      mode,
      modelPath,
      modelUri: "",
      dims,
      lastError: "",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      enabled: false,
      mode,
      modelPath,
      modelUri: "",
      dims: 0,
      lastError: message,
    };
  }
}
