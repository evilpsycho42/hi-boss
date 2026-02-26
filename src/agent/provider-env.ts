import type { Agent } from "./types.js";

type Provider = "claude" | "codex";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeEnvMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const env: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== "string") continue;
    env[key] = rawValue;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Read provider CLI env overrides from agent metadata.
 *
 * Canonical metadata shape:
 * {
 *   providerCli: {
 *     claude?: { env?: Record<string, string> },
 *     codex?:  { env?: Record<string, string> }
 *   }
 * }
 */
export function getProviderCliEnvOverrides(
  metadata: Agent["metadata"] | undefined,
  provider: Provider
): Record<string, string> | undefined {
  const md = asRecord(metadata);
  if (!md) return undefined;

  const providerCli = asRecord(md.providerCli);
  if (!providerCli) return undefined;

  const providerConfig = asRecord(providerCli[provider]);
  if (!providerConfig) return undefined;

  return normalizeEnvMap(providerConfig.env);
}

/**
 * Merge provider CLI env overrides into agent metadata.
 */
export function mergeProviderCliEnvOverrides(params: {
  metadata: Record<string, unknown> | undefined;
  provider: Provider;
  envOverrides: Record<string, string> | undefined;
}): Record<string, unknown> | undefined {
  if (!params.envOverrides || Object.keys(params.envOverrides).length < 1) {
    return params.metadata;
  }

  const nextMetadata: Record<string, unknown> = { ...(params.metadata ?? {}) };
  const providerCliCurrent = asRecord(nextMetadata.providerCli);
  const nextProviderCli: Record<string, unknown> = { ...(providerCliCurrent ?? {}) };
  const providerCurrent = asRecord(nextProviderCli[params.provider]);
  const nextProvider: Record<string, unknown> = { ...(providerCurrent ?? {}) };
  nextProvider.env = { ...params.envOverrides };
  nextProviderCli[params.provider] = nextProvider;
  nextMetadata.providerCli = nextProviderCli;
  return nextMetadata;
}

