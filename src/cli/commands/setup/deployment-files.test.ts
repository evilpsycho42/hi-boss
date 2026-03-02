import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureDockerDeploymentFiles,
  getDefaultDockerDeploymentOutputDir,
} from "./deployment-files.js";

test("ensureDockerDeploymentFiles writes compose and env files", () => {
  const hibossDir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-deploy-files-"));
  const outputDir = getDefaultDockerDeploymentOutputDir(hibossDir);
  try {
    ensureDockerDeploymentFiles({
      hibossDir,
      outputDir,
      adminToken: "AABBCCDDEEFF00112233445566778899",
    });

    const composePath = path.join(outputDir, "docker-compose.yml");
    const envPath = path.join(outputDir, ".env.docker");
    assert.equal(fs.existsSync(composePath), true);
    assert.equal(fs.existsSync(envPath), true);

    const composeBody = fs.readFileSync(composePath, "utf8");
    const envBody = fs.readFileSync(envPath, "utf8");
    assert.match(composeBody, /hiboss-daemon/);
    assert.match(composeBody, /npm install -g hiboss/);
    assert.match(composeBody, /command -v hiboss/);
    assert.match(composeBody, /HIBOSS_MANAGED_RUNTIME=off/);
    assert.match(envBody, /HIBOSS_TOKEN=aabbccddeeff00112233445566778899/);
  } finally {
    fs.rmSync(hibossDir, { recursive: true, force: true });
  }
});
