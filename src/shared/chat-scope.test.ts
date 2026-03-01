import assert from "node:assert/strict";
import test from "node:test";

import { computeDmChatId, computeTeamChatId } from "./chat-scope.js";

test("computeDmChatId sorts canonical names and allows self DM", () => {
  assert.equal(computeDmChatId("alice", "bob"), "agent-dm:alice:bob");
  assert.equal(computeDmChatId("bob", "alice"), "agent-dm:alice:bob");
  assert.equal(computeDmChatId("alice", "alice"), "agent-dm:alice:alice");
});

test("computeTeamChatId formats team scope", () => {
  assert.equal(computeTeamChatId("research"), "team:research");
});
