import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { authorizeCliOperation } from "./authz.js";
import { getSettingsPath } from "../shared/settings-io.js";
import { SETTINGS_VERSION, stringifySettings, type Settings } from "../shared/settings.js";

const ADMIN_TOKEN = "129d8c4cc9e3676a7d50d49aeb05f4f6";
const USER_TOKEN = "ce00e8e768d3ff9e155f7e69153cd541";
const AGENT_TOKEN = "32b7f2eab4503efeee12b16dfcf1fe0f";

function writeSettings(hibossDir: string): void {
  const settings: Settings = {
    version: SETTINGS_VERSION,
    timezone: "Asia/Hong_Kong",
    permissionPolicy: {
      operations: {
        "daemon.status": "admin",
        "daemon.start": "admin",
        "daemon.stop": "admin",
      },
    },
    tokens: [
      {
        name: "Ethan",
        token: ADMIN_TOKEN,
        role: "admin",
      },
      {
        name: "PolyU_CLC",
        token: USER_TOKEN,
        role: "user",
        agents: ["molbot"],
      },
    ],
    runtime: {
      sessionConcurrency: {
        perAgent: 4,
        global: 16,
      },
    },
    agents: [
      {
        name: "MolBot",
        token: AGENT_TOKEN,
        provider: "claude",
        description: "test agent",
        workspace: null,
        model: null,
        reasoningEffort: null,
        permissionLevel: "standard",
        bindings: [],
      },
    ],
  };

  fs.mkdirSync(hibossDir, { recursive: true });
  fs.writeFileSync(getSettingsPath(hibossDir), stringifySettings(settings), "utf8");
}

test("authorizeCliOperation reads settings.json when present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-authz-"));
  const previous = process.env.HIBOSS_DIR;
  try {
    writeSettings(dir);
    process.env.HIBOSS_DIR = dir;

    const admin = authorizeCliOperation("daemon.status", ADMIN_TOKEN);
    assert.equal(admin.kind, "admin");
    assert.equal(admin.level, "admin");

    assert.throws(
      () => authorizeCliOperation("daemon.status", USER_TOKEN),
      /Invalid token/
    );

    assert.throws(
      () => authorizeCliOperation("daemon.start", AGENT_TOKEN),
      /Access denied/
    );
  } finally {
    if (previous === undefined) {
      delete process.env.HIBOSS_DIR;
    } else {
      process.env.HIBOSS_DIR = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
