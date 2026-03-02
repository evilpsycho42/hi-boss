import assert from "node:assert/strict";
import test from "node:test";

import { createNewAgentChatId, computeTeamChatId } from "./chat-scope.js";

test("createNewAgentChatId returns unique ids with stable prefix", () => {
  const a = createNewAgentChatId();
  const b = createNewAgentChatId();
  assert.equal(a.startsWith("agent-chat-"), true);
  assert.equal(b.startsWith("agent-chat-"), true);
  assert.notEqual(a, b);
});

test("computeTeamChatId formats team scope", () => {
  assert.equal(computeTeamChatId("research"), "team:research");
});
