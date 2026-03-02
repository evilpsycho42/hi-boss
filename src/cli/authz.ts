import * as fs from "node:fs";
import * as path from "path";
import { getDefaultConfig } from "../daemon/daemon.js";
import { HiBossDatabase } from "../daemon/db/database.js";
import type { PermissionLevel } from "../shared/permissions.js";
import {
  DEFAULT_PERMISSION_POLICY,
  getRequiredPermissionLevel,
  isAtLeastPermissionLevel,
  parsePermissionPolicyOrDefault,
} from "../shared/permissions.js";
import { DEFAULT_AGENT_PERMISSION_LEVEL } from "../shared/defaults.js";
import { getSettingsPath, readSettingsFile } from "../shared/settings-io.js";
import type { Settings } from "../shared/settings.js";

export type Principal =
  | { kind: "admin"; level: "admin" }
  | { kind: "agent"; level: PermissionLevel; agentName: string };

function resolvePrincipalFromSettings(settings: Settings, token: string): Principal {
  const user = settings.tokens.find((entry) => entry.token === token);
  if (user?.role === "admin") {
    return { kind: "admin", level: "admin" };
  }
  if (user?.role === "user") {
    // Preserve existing CLI behavior: user tokens are not CLI principals.
    throw new Error("Invalid token");
  }

  const agent = settings.agents.find((entry) => entry.token === token);
  if (!agent) {
    throw new Error("Invalid token");
  }

  return {
    kind: "agent",
    level: agent.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL,
    agentName: agent.name,
  };
}

function authorizeFromSettings(operation: string, token: string): Principal {
  const config = getDefaultConfig();
  const settings = readSettingsFile(config.dataDir);
  const principal = resolvePrincipalFromSettings(settings, token);
  const required = getRequiredPermissionLevel(settings.permissionPolicy, operation);

  if (!isAtLeastPermissionLevel(principal.level, required)) {
    throw new Error("Access denied");
  }

  return principal;
}

export function authorizeCliOperation(operation: string, token: string): Principal {
  const config = getDefaultConfig();
  const settingsPath = getSettingsPath(config.dataDir);
  if (fs.existsSync(settingsPath)) {
    return authorizeFromSettings(operation, token);
  }

  const dbPath = path.join(config.daemonDir, "hiboss.db");
  const db = new HiBossDatabase(dbPath);

  try {
    if (!db.isSetupComplete()) {
      throw new Error(
        "Setup not complete. Run `hiboss setup` and ensure ~/hiboss/settings.json is valid."
      );
    }

    let principal: Principal | null = null;
    if (db.verifyAdminToken(token)) {
      principal = { kind: "admin", level: "admin" };
    } else {
      const agent = db.findAgentByToken(token);
      if (!agent) {
        throw new Error("Invalid token");
      }
      principal = {
        kind: "agent",
        level: agent.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL,
        agentName: agent.name,
      };
    }

    const policy = parsePermissionPolicyOrDefault(
      db.getConfig("permission_policy"),
      DEFAULT_PERMISSION_POLICY
    );
    const required = getRequiredPermissionLevel(policy, operation);

    if (!isAtLeastPermissionLevel(principal.level, required)) {
      throw new Error("Access denied");
    }

    return principal;
  } finally {
    db.close();
  }
}
