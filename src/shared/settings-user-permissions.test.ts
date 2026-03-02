import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PERMISSION_POLICY } from "./defaults.js";
import { parseSettingsJson } from "./settings.js";
import { INTERNAL_VERSION } from "./version.js";

function buildSettingsJson(extra: Record<string, unknown>): string {
  return JSON.stringify({
    version: INTERNAL_VERSION,
    timezone: "UTC",
    "permission-policy": DEFAULT_PERMISSION_POLICY.operations,
    tokens: [
      {
        name: "Ethan",
        token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        role: "admin",
        bindings: [
          {
            "adapter-type": "telegram",
            uid: "ethanelift",
          },
        ],
      },
    ],
    agents: [
      {
        name: "nex",
        token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        role: "speaker",
        provider: "codex",
        description: "",
        workspace: null,
        model: null,
        "reasoning-effort": null,
        "permission-level": "standard",
        bindings: [
          {
            "adapter-type": "telegram",
            "adapter-token": "bot-token",
          },
        ],
      },
      {
        name: "kai",
        token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        role: "leader",
        provider: "codex",
        description: "",
        workspace: null,
        model: null,
        "reasoning-effort": null,
        "permission-level": "standard",
        bindings: [],
      },
    ],
    ...extra,
  });
}

test("parseSettingsJson accepts valid user-permission-policy", () => {
  const settings = parseSettingsJson(
    buildSettingsJson({
      tokens: [
        {
          name: "Ethan",
          token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          role: "admin",
        },
        {
          name: "LPC",
          token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          role: "user",
          agents: ["nex"],
          bindings: [
            {
              "adapter-type": "telegram",
              uid: "lpcfjx",
            },
          ],
        },
      ],
    })
  );

  assert.equal(settings.tokens[1]?.token, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(settings.tokens[1]?.role, "user");
  assert.deepEqual(settings.tokens[1]?.agents, ["nex"]);
  assert.equal(settings.tokens[1]?.bindings?.[0]?.uid, "lpcfjx");
});

test("parseSettingsJson rejects invalid tokens policy", () => {
  assert.throws(
    () =>
      parseSettingsJson(
        buildSettingsJson({
          tokens: [
            {
              name: "Ethan",
              token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              role: "admin",
            },
            {
              name: "Bad",
              token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              role: "user",
            },
          ],
        })
      ),
    /tokens/i
  );
});

test("parseSettingsJson accepts runtime deployment config", () => {
  const settings = parseSettingsJson(
    buildSettingsJson({
      runtime: {
        "session-concurrency": {
          "per-agent": 4,
          global: 16,
        },
        deployment: {
          mode: "docker",
          "output-dir": "/hiboss/services/hiboss-daemon",
        },
      },
    })
  );

  assert.equal(settings.runtime?.deployment?.mode, "docker");
  assert.equal(settings.runtime?.deployment?.outputDir, "/hiboss/services/hiboss-daemon");
});

test("parseSettingsJson accepts runtime session handoff config", () => {
  const settings = parseSettingsJson(
    buildSettingsJson({
      runtime: {
        "session-handoff": {
          "recent-days": 5,
          "per-session-max-chars": 24000,
          "max-retries": 4,
        },
      },
    }),
  );

  assert.equal(settings.runtime?.sessionHandoff?.recentDays, 5);
  assert.equal(settings.runtime?.sessionHandoff?.perSessionMaxChars, 24000);
  assert.equal(settings.runtime?.sessionHandoff?.maxRetries, 4);
});

test("parseSettingsJson rejects invalid runtime session handoff config", () => {
  assert.throws(
    () =>
      parseSettingsJson(
        buildSettingsJson({
          runtime: {
            "session-handoff": {
              "recent-days": 0,
            },
          },
        }),
      ),
    /runtime\.session-handoff\.recent-days/i,
  );
});

test("parseSettingsJson rejects runtime deployment with relative output-dir", () => {
  assert.throws(
    () =>
      parseSettingsJson(
        buildSettingsJson({
          runtime: {
            deployment: {
              mode: "docker",
              "output-dir": "services/hiboss-daemon",
            },
          },
        })
      ),
    /runtime\.deployment\.output-dir/i
  );
});

test("parseSettingsJson accepts global providerCli claude env", () => {
  const settings = parseSettingsJson(
    buildSettingsJson({
      providerCli: {
        claude: {
          env: {
            ANTHROPIC_BASE_URL: "https://cch.ethanelift.com",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
          },
        },
      },
    })
  );

  assert.equal(settings.providerCli?.claude?.env?.ANTHROPIC_BASE_URL, "https://cch.ethanelift.com");
  assert.equal(settings.providerCli?.claude?.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(settings.providerCli?.claude?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "1");
});
