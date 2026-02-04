import { createHash } from "node:crypto";

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

function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g);
  return tokens ?? [];
}

function floatFromHash(key: string, dim: number): number {
  const h = createHash("sha256").update(key).update(":").update(String(dim)).digest();
  const n = h.readUInt32LE(0);
  const u = n / 0xffffffff;
  return u * 2 - 1;
}

export function embedTextForExamples(text: string, dims: number): number[] {
  const safeDims = Math.trunc(dims);
  if (!Number.isFinite(safeDims) || safeDims <= 0) {
    throw new Error("Invalid dims");
  }

  const trimmed = text.trim();
  const tokens = tokenize(trimmed);
  const features = tokens.length > 0 ? tokens : [trimmed || "(empty)"];

  const vector = new Array<number>(safeDims).fill(0);
  for (const t of features) {
    for (let i = 0; i < safeDims; i++) {
      vector[i] += floatFromHash(t, i);
    }
  }

  return normalizeVector(vector);
}

