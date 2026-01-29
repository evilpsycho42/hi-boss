import { DEFAULT_PERMISSION_POLICY } from "./defaults.js";

export type PermissionLevel = "restricted" | "standard" | "privileged" | "boss";

export interface PermissionPolicyV1 {
  version: 1;
  operations: Record<string, PermissionLevel>;
}

export { DEFAULT_PERMISSION_POLICY };

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return (
    value === "restricted" ||
    value === "standard" ||
    value === "privileged" ||
    value === "boss"
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
    case "boss":
      return 3;
  }
}

export function isAtLeastPermissionLevel(
  actual: PermissionLevel,
  required: PermissionLevel
): boolean {
  return permissionLevelRank(actual) >= permissionLevelRank(required);
}

export function getRequiredPermissionLevel(
  policy: PermissionPolicyV1,
  operation: string
): PermissionLevel {
  const value = policy.operations[operation];
  return value ?? "boss";
}

export function parsePermissionPolicyV1(json: string): PermissionPolicyV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid permission policy JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid permission policy (expected object)");
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error("Invalid permission policy version (expected 1)");
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

  return { version: 1, operations };
}

export function parsePermissionPolicyV1OrDefault(
  json: string | null | undefined,
  fallback: PermissionPolicyV1 = DEFAULT_PERMISSION_POLICY
): PermissionPolicyV1 {
  if (!json || !json.trim()) return fallback;

  try {
    return parsePermissionPolicyV1(json);
  } catch {
    return fallback;
  }
}
