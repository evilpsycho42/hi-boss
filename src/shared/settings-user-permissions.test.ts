import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PERMISSION_POLICY } from "./defaults.js";
import { parseSettingsJson } from "./settings.js";
import { INTERNAL_VERSION } from "./version.js";

function buildSettingsJson(extra: Record<string, unknown>): string {
  return JSON.stringify({
    version: INTERNAL_VERSION,
    boss: {
      name: "boss",
      timezone: "UTC",
    },
    admin: {
      token: "1234567890abcdef",
    },
    telegram: {
      "boss-ids": ["boss_user"],
    },
    "permission-policy": DEFAULT_PERMISSION_POLICY,
    agents: [
      {
        name: "nex",
        token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
      "user-permission-policy": {
        version: INTERNAL_VERSION,
        roles: {
          boss: { allow: ["channel.command.*", "channel.message.send"] },
          operator: { allow: ["channel.command.status"] },
        },
        bindings: [
          {
            "adapter-type": "telegram",
            "user-id": "u-1",
            token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            role: "operator",
          },
        ],
        defaults: {
          "unmapped-user-role": "operator",
        },
      },
    })
  );

  assert.equal(settings.userPermissionPolicy?.defaults.unmappedUserRole, "operator");
  assert.equal(settings.userPermissionPolicy?.bindings[0]?.userId, "u-1");
  assert.equal(settings.userPermissionPolicy?.bindings[0]?.token, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
});

test("parseSettingsJson rejects invalid user-permission-policy", () => {
  assert.throws(
    () =>
      parseSettingsJson(
        buildSettingsJson({
          "user-permission-policy": {
            version: INTERNAL_VERSION,
            roles: {
              boss: { allow: ["channel.command.*"] },
            },
            bindings: [],
            defaults: {
              "unmapped-user-role": "missing-role",
            },
          },
        })
      ),
    /user-permission-policy/i
  );
});
