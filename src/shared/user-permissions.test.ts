import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateUserPermission,
  parseUserPermissionPolicyFromObject,
} from "./user-permissions.js";
import { INTERNAL_VERSION } from "./version.js";

function buildPolicy() {
  return parseUserPermissionPolicyFromObject({
    version: INTERNAL_VERSION,
    roles: {
      boss: { allow: ["channel.command.*", "channel.message.send"] },
      operator: { allow: ["channel.command.status", "channel.message.send"] },
      viewer: { allow: ["channel.command.status"] },
      blocked: { allow: [] },
    },
    bindings: [
      {
        "adapter-type": "telegram",
        "user-id": "u-op",
        token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        role: "operator",
      },
      {
        "adapter-type": "telegram",
        username: "@viewer_name",
        token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        role: "viewer",
      },
      {
        "adapter-type": "telegram",
        username: "@boss_user",
        token: "cccccccccccccccccccccccccccccccc",
        role: "boss",
      },
    ],
    defaults: { "unmapped-user-role": "blocked" },
  });
}

test("parseUserPermissionPolicyFromObject normalizes roles, usernames, and patterns", () => {
  const policy = buildPolicy();
  assert.equal(policy.bindings[1]?.username, "viewer_name");
  assert.ok(policy.roles.operator.allow.includes("channel.command.status"));
  assert.ok(policy.roles.boss.allow.includes("channel.command.*"));
});

test("parseUserPermissionPolicyFromObject rejects unknown defaults role", () => {
  assert.throws(
    () =>
      parseUserPermissionPolicyFromObject({
        version: INTERNAL_VERSION,
        roles: {
          boss: { allow: ["channel.command.*"] },
        },
        bindings: [],
        defaults: { "unmapped-user-role": "missing" },
      }),
    /unknown role/i
  );
});

test("evaluateUserPermission resolves by user-id then username then default role", () => {
  const policy = buildPolicy();

  const byId = evaluateUserPermission(
    policy,
    {
      adapterType: "telegram",
      channelUserId: "u-op",
      channelUsername: "someone",
    },
    "channel.command.status"
  );
  assert.equal(byId.allowed, true);
  assert.equal(byId.role, "operator");
  assert.equal(byId.token, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  const byUsername = evaluateUserPermission(
    policy,
    {
      adapterType: "telegram",
      channelUserId: "other-id",
      channelUsername: "@viewer_name",
    },
    "channel.command.status"
  );
  assert.equal(byUsername.allowed, true);
  assert.equal(byUsername.role, "viewer");
  assert.equal(byUsername.token, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

  const fallback = evaluateUserPermission(
    policy,
    {
      adapterType: "telegram",
      channelUserId: "unknown",
      channelUsername: "unknown",
    },
    "channel.command.status"
  );
  assert.equal(fallback.allowed, false);
  assert.equal(fallback.role, "blocked");
  assert.equal(fallback.token, undefined);
});

test("evaluateUserPermission resolves boss role from binding and applies wildcard action", () => {
  const policy = buildPolicy();
  const decision = evaluateUserPermission(
    policy,
    {
      adapterType: "telegram",
      channelUserId: "unknown-id",
      channelUsername: "boss_user",
    },
    "channel.command.abort"
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.role, "boss");
  assert.equal(decision.token, "cccccccccccccccccccccccccccccccc");
});
