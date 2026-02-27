import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Agent } from "../agent/types.js";
import { buildSystemPromptContext } from "./prompt-context.js";

test("buildSystemPromptContext includes configured and team workspaces together", () => {
  const hibossDir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-prompt-context-"));
  try {
    const agent: Agent = {
      name: "nex",
      token: "tok_123",
      workspace: "/workspace/agent-personal",
      provider: "codex",
      createdAt: Date.now(),
    };

    const ctx = buildSystemPromptContext({
      agent,
      agentToken: agent.token,
      bindings: [],
      workspaceDir: "/workspace/team-alpha",
      teams: [
        {
          name: "alpha",
          members: ["nex"],
          teamspaceDir: "/workspace/team-alpha",
        },
        {
          name: "beta",
          members: ["nex"],
          teamspaceDir: "/workspace/team-beta",
        },
      ],
      hibossDir,
    }) as {
      agent: {
        workspace: string;
        workspaceConfigured: string;
        teamWorkspaces: string[];
        allWorkspaces: string[];
      };
      workspace: {
        dir: string;
        configuredDir: string;
        teamDirs: string[];
        allDirs: string[];
      };
    };

    assert.equal(ctx.agent.workspace, "/workspace/team-alpha");
    assert.equal(ctx.agent.workspaceConfigured, "/workspace/agent-personal");
    assert.deepEqual(ctx.agent.teamWorkspaces, [
      "/workspace/team-alpha",
      "/workspace/team-beta",
    ]);
    assert.deepEqual(ctx.agent.allWorkspaces, [
      "/workspace/team-alpha",
      "/workspace/agent-personal",
      "/workspace/team-beta",
    ]);

    assert.equal(ctx.workspace.dir, "/workspace/team-alpha");
    assert.equal(ctx.workspace.configuredDir, "/workspace/agent-personal");
    assert.deepEqual(ctx.workspace.teamDirs, [
      "/workspace/team-alpha",
      "/workspace/team-beta",
    ]);
    assert.deepEqual(ctx.workspace.allDirs, [
      "/workspace/team-alpha",
      "/workspace/agent-personal",
      "/workspace/team-beta",
    ]);
  } finally {
    fs.rmSync(hibossDir, { recursive: true, force: true });
  }
});
