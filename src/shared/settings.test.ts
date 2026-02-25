import assert from "node:assert/strict";
import test from "node:test";

import { parseSettingsV4Json, stringifySettingsV4 } from "./settings.js";

function buildBaseJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    version: 4,
    boss: {
      name: "Ethan",
      timezone: "America/Los_Angeles",
    },
    admin: {
      token: "1234567890abcdef",
    },
    "permission-policy": {
      version: 1,
      operations: {},
    },
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
            "adapter-type": "wechatpadpro",
            "adapter-token": "token-1",
          },
        ],
      },
      {
        name: "kai",
        token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        role: "leader",
        provider: "claude",
        description: "",
        workspace: null,
        model: null,
        "reasoning-effort": null,
        "permission-level": "standard",
        bindings: [],
      },
    ],
    ...overrides,
  });
}

test("settings parser accepts wechatpadpro-only boss ids", () => {
  const parsed = parseSettingsV4Json(
    buildBaseJson({
      wechatpadpro: {
        "boss-ids": ["wxid_boss_1", "wxid_boss_2"],
      },
    })
  );

  assert.equal(parsed.telegram, undefined);
  assert.deepEqual(parsed.wechatpadpro?.bossIds, ["wxid_boss_1", "wxid_boss_2"]);
});

test("settings parser rejects missing channel boss-id config", () => {
  assert.throws(
    () =>
      parseSettingsV4Json(
        buildBaseJson({})
      ),
    /must configure at least one of telegram\.boss-ids or wechatpadpro\.boss-ids/
  );
});

test("stringify keeps wechatpadpro channel block", () => {
  const parsed = parseSettingsV4Json(
    buildBaseJson({
      wechatpadpro: {
        "boss-ids": ["wxid_boss_1"],
      },
    })
  );
  const output = stringifySettingsV4(parsed);
  assert.equal(output.includes("\"wechatpadpro\""), true);
  assert.equal(output.includes("\"telegram\""), false);
});
