import * as path from "path";
import { getDefaultConfig } from "../daemon/daemon.js";
import { HiBossDatabase } from "../daemon/db/database.js";
import type { PermissionLevel } from "../shared/permissions.js";
import {
  DEFAULT_PERMISSION_POLICY,
  getRequiredPermissionLevel,
  isAtLeastPermissionLevel,
  parsePermissionPolicyV1OrDefault,
} from "../shared/permissions.js";

export type Principal =
  | { kind: "boss"; level: "boss" }
  | { kind: "agent"; level: PermissionLevel; agentName: string };

function getAgentPermissionLevel(metadata: unknown): PermissionLevel {
  const raw = (metadata as { permissionLevel?: unknown } | undefined)?.permissionLevel;
  if (raw === "restricted" || raw === "standard" || raw === "privileged") {
    return raw;
  }
  return "standard";
}

export function authorizeCliOperation(operation: string, token: string): Principal {
  const config = getDefaultConfig();
  const dbPath = path.join(config.dataDir, "hiboss.db");
  const db = new HiBossDatabase(dbPath);

  try {
    if (!db.isSetupComplete()) {
      throw new Error("Setup not complete. Run: hiboss setup");
    }

    let principal: Principal | null = null;
    if (db.verifyBossToken(token)) {
      principal = { kind: "boss", level: "boss" };
    } else {
      const agent = db.findAgentByToken(token);
      if (!agent) {
        throw new Error("Invalid token");
      }
      principal = {
        kind: "agent",
        level: getAgentPermissionLevel(agent.metadata),
        agentName: agent.name,
      };
    }

    const policy = parsePermissionPolicyV1OrDefault(
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

