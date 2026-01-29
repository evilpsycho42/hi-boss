import * as fs from "fs";
import * as path from "path";
import { getDefaultConfig } from "../../daemon/daemon.js";
import { HiBossDatabase } from "../../daemon/db/database.js";
import { authorizeCliOperation } from "../authz.js";
import { resolveToken } from "../token.js";
import {
  DEFAULT_PERMISSION_POLICY,
  parsePermissionPolicyV1,
  parsePermissionPolicyV1OrDefault,
} from "../../shared/permissions.js";

export interface PermissionPolicyGetOptions {
  token?: string;
}

export interface PermissionPolicySetOptions {
  token?: string;
  file: string;
}

function getDb(): HiBossDatabase {
  const config = getDefaultConfig();
  const dbPath = path.join(config.dataDir, "hiboss.db");
  return new HiBossDatabase(dbPath);
}

export async function getPermissionPolicy(options: PermissionPolicyGetOptions): Promise<void> {
  try {
    const token = resolveToken(options.token);
    authorizeCliOperation("permission.policy.get", token);

    const db = getDb();
    try {
      const raw = db.getConfig("permission_policy");
      const policy = parsePermissionPolicyV1OrDefault(raw, DEFAULT_PERMISSION_POLICY);
      console.log(`policy-json: ${JSON.stringify(policy)}`);
    } finally {
      db.close();
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function setPermissionPolicy(options: PermissionPolicySetOptions): Promise<void> {
  try {
    const token = resolveToken(options.token);
    authorizeCliOperation("permission.policy.set", token);

    const filePath = path.resolve(process.cwd(), options.file);
    const json = await fs.promises.readFile(filePath, "utf-8");
    const policy = parsePermissionPolicyV1(json);

    const db = getDb();
    try {
      db.setConfig("permission_policy", JSON.stringify(policy));
    } finally {
      db.close();
    }

    console.log("success: true");
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

