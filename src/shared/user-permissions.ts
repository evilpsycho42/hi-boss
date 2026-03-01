import { INTERNAL_VERSION } from "./version.js";

export interface UserPermissionRoleDefinition {
  allow: string[];
}

export interface UserPermissionBinding {
  adapterType: string;
  userId?: string;
  username?: string;
  role: string;
}

export interface UserPermissionPolicy {
  version: typeof INTERNAL_VERSION;
  roles: Record<string, UserPermissionRoleDefinition>;
  bindings: UserPermissionBinding[];
  defaults: {
    unmappedUserRole: string;
  };
}

export interface UserPermissionPrincipal {
  adapterType: string;
  channelUserId?: string;
  channelUsername?: string;
  fromBoss: boolean;
}

export interface UserPermissionDecision {
  allowed: boolean;
  role: string;
  action: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(fieldPath: string, message: string): never {
  throw new Error(`Invalid user permission policy (${fieldPath}): ${message}`);
}

function normalizeRole(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeAdapterType(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

function normalizeActionPattern(raw: string): string {
  return raw.trim().toLowerCase();
}

function isValidActionPattern(value: string): boolean {
  if (!value) return false;
  if (value === "*") return true;

  const segments = value.split(".");
  if (segments.length < 1) return false;

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (segment === "*") {
      // Wildcards are supported only as the last segment (e.g. channel.command.*)
      return index === segments.length - 1;
    }
    if (!/^[a-z0-9-]+$/.test(segment)) {
      return false;
    }
  }

  return true;
}

function parseRoles(raw: unknown): UserPermissionPolicy["roles"] {
  if (!isObject(raw)) {
    fail("roles", "must be an object");
  }

  const roles: UserPermissionPolicy["roles"] = {};
  const seen = new Set<string>();

  for (const [rawRoleName, rawRoleDef] of Object.entries(raw)) {
    const roleName = normalizeRole(rawRoleName);
    if (!roleName) {
      fail("roles", "role name must not be empty");
    }
    if (seen.has(roleName)) {
      fail(`roles.${rawRoleName}`, "duplicate role name");
    }
    seen.add(roleName);

    if (!isObject(rawRoleDef)) {
      fail(`roles.${rawRoleName}`, "must be an object");
    }

    const allowRaw = rawRoleDef.allow;
    if (!Array.isArray(allowRaw)) {
      fail(`roles.${rawRoleName}.allow`, "must be an array");
    }

    const allow: string[] = [];
    const patternSeen = new Set<string>();
    for (let index = 0; index < allowRaw.length; index++) {
      const value = allowRaw[index];
      if (typeof value !== "string") {
        fail(`roles.${rawRoleName}.allow[${index}]`, "must be a string");
      }
      const pattern = normalizeActionPattern(value);
      if (!isValidActionPattern(pattern)) {
        fail(`roles.${rawRoleName}.allow[${index}]`, "must be a valid action pattern");
      }
      if (patternSeen.has(pattern)) continue;
      patternSeen.add(pattern);
      allow.push(pattern);
    }

    roles[roleName] = { allow };
  }

  if (Object.keys(roles).length < 1) {
    fail("roles", "must define at least one role");
  }
  if (!roles.boss) {
    fail("roles.boss", "role 'boss' is required");
  }

  return roles;
}

function parseBindings(raw: unknown, roles: UserPermissionPolicy["roles"]): UserPermissionBinding[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    fail("bindings", "must be an array");
  }

  const bindings: UserPermissionBinding[] = [];
  const userIdKeys = new Set<string>();
  const usernameKeys = new Set<string>();

  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!isObject(item)) {
      fail(`bindings[${index}]`, "must be an object");
    }

    const adapterTypeRaw =
      typeof item["adapter-type"] === "string"
        ? item["adapter-type"]
        : typeof item.adapterType === "string"
          ? item.adapterType
          : "";
    const adapterType = normalizeAdapterType(adapterTypeRaw);
    if (!adapterType) {
      fail(`bindings[${index}].adapter-type`, "is required");
    }

    const roleRaw = typeof item.role === "string" ? item.role : "";
    const role = normalizeRole(roleRaw);
    if (!role) {
      fail(`bindings[${index}].role`, "is required");
    }
    if (!roles[role]) {
      fail(`bindings[${index}].role`, `unknown role '${roleRaw}'`);
    }

    const userIdRaw =
      typeof item["user-id"] === "string"
        ? item["user-id"]
        : typeof item.userId === "string"
          ? item.userId
          : "";
    const userId = userIdRaw.trim();
    const usernameRaw = typeof item.username === "string" ? item.username : "";
    const username = normalizeUsername(usernameRaw);

    if (!userId && !username) {
      fail(`bindings[${index}]`, "must include user-id or username");
    }

    if (userId) {
      const key = `${adapterType}\u0000${userId}`;
      if (userIdKeys.has(key)) {
        fail(`bindings[${index}].user-id`, "duplicate binding for adapter-type + user-id");
      }
      userIdKeys.add(key);
    }
    if (username) {
      const key = `${adapterType}\u0000${username}`;
      if (usernameKeys.has(key)) {
        fail(`bindings[${index}].username`, "duplicate binding for adapter-type + username");
      }
      usernameKeys.add(key);
    }

    bindings.push({
      adapterType,
      ...(userId ? { userId } : {}),
      ...(username ? { username } : {}),
      role,
    });
  }

  return bindings;
}

function parseDefaults(
  raw: unknown,
  roles: UserPermissionPolicy["roles"]
): UserPermissionPolicy["defaults"] {
  if (!isObject(raw)) {
    fail("defaults", "must be an object");
  }

  const rawRole =
    typeof raw["unmapped-user-role"] === "string"
      ? raw["unmapped-user-role"]
      : typeof raw.unmappedUserRole === "string"
        ? raw.unmappedUserRole
        : "";
  const unmappedUserRole = normalizeRole(rawRole);
  if (!unmappedUserRole) {
    fail("defaults.unmapped-user-role", "is required");
  }
  if (!roles[unmappedUserRole]) {
    fail("defaults.unmapped-user-role", `unknown role '${rawRole}'`);
  }

  return { unmappedUserRole };
}

export function parseUserPermissionPolicyFromObject(parsed: unknown): UserPermissionPolicy {
  if (!isObject(parsed)) {
    fail("root", "must be an object");
  }
  if (parsed.version !== INTERNAL_VERSION) {
    fail("version", `expected ${INTERNAL_VERSION}`);
  }

  const roles = parseRoles(parsed.roles);
  const bindings = parseBindings(parsed.bindings, roles);
  const defaults = parseDefaults(parsed.defaults, roles);

  return {
    version: INTERNAL_VERSION,
    roles,
    bindings,
    defaults,
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

export function parseUserPermissionPolicyOrNull(
  json: string | null | undefined
): UserPermissionPolicy | null {
  if (!json || !json.trim()) return null;
  try {
    return parseUserPermissionPolicy(json);
  } catch {
    return null;
  }
}

function actionMatches(pattern: string, action: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return action === prefix || action.startsWith(`${prefix}.`);
  }
  return pattern === action;
}

export function resolveUserPermissionRole(
  policy: UserPermissionPolicy,
  principal: UserPermissionPrincipal
): string {
  if (principal.fromBoss && policy.roles.boss) {
    return "boss";
  }

  const adapterType = normalizeAdapterType(principal.adapterType);
  const userId = typeof principal.channelUserId === "string" ? principal.channelUserId.trim() : "";
  const username =
    typeof principal.channelUsername === "string"
      ? normalizeUsername(principal.channelUsername)
      : "";

  if (userId) {
    const matchedById = policy.bindings.find(
      (binding) => binding.adapterType === adapterType && binding.userId === userId
    );
    if (matchedById) return matchedById.role;
  }

  if (username) {
    const matchedByUsername = policy.bindings.find(
      (binding) => binding.adapterType === adapterType && binding.username === username
    );
    if (matchedByUsername) return matchedByUsername.role;
  }

  return policy.defaults.unmappedUserRole;
}

export function evaluateUserPermission(
  policy: UserPermissionPolicy,
  principal: UserPermissionPrincipal,
  actionRaw: string
): UserPermissionDecision {
  const action = normalizeActionPattern(actionRaw);
  const role = resolveUserPermissionRole(policy, principal);
  const roleDef = policy.roles[role];
  if (!roleDef) {
    return { allowed: false, role, action };
  }

  const allowed = roleDef.allow.some((pattern) => actionMatches(pattern, action));
  return {
    allowed,
    role,
    action,
  };
}
