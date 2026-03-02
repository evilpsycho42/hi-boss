import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "./validation.js";

export type UserPermissionRole = "admin" | "user";

export interface UserPermissionBinding {
  adapterType: string;
  uid: string;
}

export interface UserPermissionUser {
  name: string;
  token: string;
  role: UserPermissionRole;
  agents?: string[];
  bindings?: UserPermissionBinding[];
}

export interface UserPermissionPolicy {
  tokens: UserPermissionUser[];
}

export interface UserPermissionDecision {
  allowed: boolean;
  token?: string;
  role?: UserPermissionRole;
  userName?: string;
  targetAgentName: string;
  fromBoss: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(fieldPath: string, message: string): never {
  throw new Error(`Invalid user permission policy (${fieldPath}): ${message}`);
}

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeAgentName(raw: string): string {
  return raw.trim().toLowerCase();
}

function isValidToken(token: string): boolean {
  return /^[0-9a-f]{32}$/.test(token);
}

function parseBindings(raw: unknown, fieldPath: string): UserPermissionBinding[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    fail(fieldPath, "must be an array");
  }

  const bindings: UserPermissionBinding[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const value = raw[index];
    if (!isObject(value)) {
      fail(`${fieldPath}[${index}]`, "must be an object");
    }
    const adapterTypeRaw = typeof value["adapter-type"] === "string"
      ? value["adapter-type"]
      : typeof value.adapterType === "string"
        ? value.adapterType
        : "";
    const adapterType = adapterTypeRaw.trim().toLowerCase();
    if (!adapterType) {
      fail(`${fieldPath}[${index}].adapter-type`, "is required");
    }

    const uid = typeof value.uid === "string"
      ? value.uid.trim().replace(/^@/, "").toLowerCase()
      : "";
    if (!uid) {
      fail(`${fieldPath}[${index}].uid`, "is required");
    }

    const key = `${adapterType}\u0000${uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({ adapterType, uid });
  }
  return bindings;
}

function parseAgentNames(raw: unknown, fieldPath: string): string[] {
  if (!Array.isArray(raw)) {
    fail(fieldPath, "must be an array");
  }

  const names: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < raw.length; index++) {
    const value = raw[index];
    if (typeof value !== "string") {
      fail(`${fieldPath}[${index}]`, "must be a string");
    }

    const normalized = normalizeAgentName(value);
    if (!normalized) {
      fail(`${fieldPath}[${index}]`, "must not be empty");
    }
    if (normalized === "*") {
      fail(`${fieldPath}[${index}]`, "user role must list concrete agent names");
    }

    if (!isValidAgentName(normalized)) {
      fail(`${fieldPath}[${index}]`, AGENT_NAME_ERROR_MESSAGE);
    }

    if (seen.has(normalized)) continue;
    seen.add(normalized);
    names.push(normalized);
  }

  if (names.length < 1) {
    fail(fieldPath, "must contain at least one agent name");
  }

  return names;
}

function parseUsers(raw: unknown): UserPermissionUser[] {
  if (!Array.isArray(raw)) {
    fail("tokens", "must be an array");
  }

  const users: UserPermissionUser[] = [];
  const tokenKeys = new Set<string>();

  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!isObject(item)) {
      fail(`tokens[${index}]`, "must be an object");
    }

    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) {
      fail(`tokens[${index}].name`, "is required");
    }

    const tokenRaw = typeof item.token === "string" ? item.token : "";
    const token = normalizeToken(tokenRaw);
    if (!token) {
      fail(`tokens[${index}].token`, "is required");
    }
    if (!isValidToken(token)) {
      fail(`tokens[${index}].token`, "must be 32 lowercase hex characters");
    }
    if (tokenKeys.has(token)) {
      fail(`tokens[${index}].token`, "duplicate token");
    }

    const roleRaw = typeof item.role === "string" ? item.role.trim().toLowerCase() : "";
    if (roleRaw !== "admin" && roleRaw !== "user") {
      fail(`tokens[${index}].role`, "must be admin or user");
    }

    const bindings = parseBindings(item.bindings, `tokens[${index}].bindings`);

    if (roleRaw === "admin") {
      if (item.agents !== undefined && item.agents !== null) {
        fail(`tokens[${index}].agents`, "must not be set when role is admin");
      }
      users.push({
        name,
        token,
        role: "admin",
        ...(bindings.length > 0 ? { bindings } : {}),
      });
    } else {
      const agents = parseAgentNames(item.agents, `tokens[${index}].agents`);
      users.push({
        name,
        token,
        role: "user",
        agents,
        ...(bindings.length > 0 ? { bindings } : {}),
      });
    }

    tokenKeys.add(token);
  }

  return users;
}

export function parseUserPermissionPolicyFromObject(parsed: unknown): UserPermissionPolicy {
  if (!isObject(parsed)) {
    fail("root", "must be an object");
  }
  const users = parseUsers(parsed.tokens);

  return {
    tokens: users,
  };
}

export function parseUserPermissionPolicy(json: string): UserPermissionPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid user permission policy JSON");
  }

  return parseUserPermissionPolicyFromObject(parsed);
}

export function resolveUserPermissionUserByToken(
  policy: UserPermissionPolicy,
  tokenRaw: string
): UserPermissionUser | undefined {
  const token = normalizeToken(tokenRaw);
  if (!token) return undefined;
  return policy.tokens.find((user) => user.token === token);
}

export function evaluateUserPermissionByToken(
  policy: UserPermissionPolicy,
  tokenRaw: string,
  targetAgentNameRaw: string
): UserPermissionDecision {
  const targetAgentName = normalizeAgentName(targetAgentNameRaw);
  const user = resolveUserPermissionUserByToken(policy, tokenRaw);

  if (!user) {
    return { allowed: false, targetAgentName, fromBoss: false };
  }

  if (user.role === "admin") {
    return {
      allowed: true,
      token: user.token,
      role: user.role,
      userName: user.name,
      targetAgentName,
      fromBoss: true,
    };
  }

  const allowed = user.agents?.includes(targetAgentName) ?? false;
  return {
    allowed,
    token: user.token,
    role: user.role,
    userName: user.name,
    targetAgentName,
    fromBoss: false,
  };
}
