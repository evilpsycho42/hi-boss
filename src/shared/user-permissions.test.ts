import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateUserPermissionByToken,
  parseUserPermissionPolicyFromObject,
  resolveUserPermissionUserByToken,
} from "./user-permissions.js";

function buildPolicy() {
  return parseUserPermissionPolicyFromObject({
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
      {
        name: "LPC",
        token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        role: "user",
        agents: ["nex", "kai"],
        bindings: [
          {
            "adapter-type": "telegram",
            uid: "lpcfjx",
          },
        ],
      },
    ],
  });
}

test("parseUserPermissionPolicyFromObject parses users policy", () => {
  const policy = buildPolicy();
  assert.equal(policy.tokens.length, 2);
  assert.equal(policy.tokens[0]?.role, "admin");
  assert.deepEqual(policy.tokens[1]?.agents, ["nex", "kai"]);
  assert.equal(policy.tokens[0]?.bindings?.[0]?.uid, "ethanelift");
});

test("parseUserPermissionPolicyFromObject rejects admin with agents", () => {
  assert.throws(
    () =>
      parseUserPermissionPolicyFromObject({
        tokens: [
          {
            name: "Admin",
            token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            role: "admin",
            agents: ["nex"],
          },
        ],
      }),
    /must not be set when role is admin/i
  );
});

test("resolveUserPermissionUserByToken resolves token user", () => {
  const policy = buildPolicy();
  const admin = resolveUserPermissionUserByToken(policy, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(admin?.name, "Ethan");
  assert.equal(admin?.role, "admin");

  const missing = resolveUserPermissionUserByToken(policy, "cccccccccccccccccccccccccccccccc");
  assert.equal(missing, undefined);
});

test("evaluateUserPermissionByToken enforces role semantics", () => {
  const policy = buildPolicy();

  const admin = evaluateUserPermissionByToken(policy, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "whatever");
  assert.equal(admin.allowed, true);
  assert.equal(admin.fromBoss, true);
  assert.equal(admin.role, "admin");

  const userAllowed = evaluateUserPermissionByToken(policy, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "nex");
  assert.equal(userAllowed.allowed, true);
  assert.equal(userAllowed.fromBoss, false);
  assert.equal(userAllowed.role, "user");

  const userDenied = evaluateUserPermissionByToken(policy, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "shieru");
  assert.equal(userDenied.allowed, false);
  assert.equal(userDenied.fromBoss, false);

  const unknown = evaluateUserPermissionByToken(policy, "cccccccccccccccccccccccccccccccc", "nex");
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.fromBoss, false);
  assert.equal(unknown.role, undefined);
});
