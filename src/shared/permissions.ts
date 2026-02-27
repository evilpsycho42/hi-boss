import { DEFAULT_PERMISSION_POLICY } from "./defaults.js";
import { INTERNAL_VERSION } from "./version.js";

export type PermissionLevel = "restricted" | "standard" | "privileged" | "admin";
export const PERMISSION_POLICY_VERSION = INTERNAL_VERSION;

export interface PermissionPolicy {
  version: typeof PERMISSION_POLICY_VERSION;
  operations: Record<string, PermissionLevel>;
}

export { DEFAULT_PERMISSION_POLICY };

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return (
    value === "restricted" ||
    value === "standard" ||
    value === "privileged" ||
    value === "admin"
  );
}

export function permissionLevelRank(level: PermissionLevel): number {
  switch (level) {
    case "restricted":
      return 0;
    case "standard":
      return 1;
    case "privileged":
      return 2;
    case "admin":
      return 3;
  }

  throw new Error(`Unknown permission level: ${String(level)}`);
}

export function isAtLeastPermissionLevel(
  actual: PermissionLevel,
  required: PermissionLevel
): boolean {
  return permissionLevelRank(actual) >= permissionLevelRank(required);
}

export function getRequiredPermissionLevel(
  policy: PermissionPolicy,
  operation: string
): PermissionLevel {
  const value = policy.operations[operation];
  return value ?? "admin";
}

export function parsePermissionPolicy(json: string): PermissionPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid permission policy JSON");
  }

  return parsePermissionPolicyFromObject(parsed);
}

export function parsePermissionPolicyFromObject(parsed: unknown): PermissionPolicy {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid permission policy (expected object)");
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.version !== PERMISSION_POLICY_VERSION) {
    throw new Error(`Invalid permission policy version (expected ${PERMISSION_POLICY_VERSION})`);
  }

  if (typeof obj.operations !== "object" || obj.operations === null) {
    throw new Error("Invalid permission policy (expected operations object)");
  }

  const operationsRaw = obj.operations as Record<string, unknown>;
  const operations: Record<string, PermissionLevel> = {};

  for (const [key, value] of Object.entries(operationsRaw)) {
    if (typeof key !== "string" || key.trim() === "") {
      throw new Error("Invalid permission policy (empty operation name)");
    }
    if (!isPermissionLevel(value)) {
      throw new Error(`Invalid permission policy level for ${key}`);
    }
    operations[key] = value;
  }

  return { version: PERMISSION_POLICY_VERSION, operations };
}

export function parsePermissionPolicyOrDefault(
  json: string | null | undefined,
  fallback: PermissionPolicy = DEFAULT_PERMISSION_POLICY
): PermissionPolicy {
  if (!json || !json.trim()) return fallback;

  try {
    return parsePermissionPolicy(json);
  } catch {
    return fallback;
  }
}
