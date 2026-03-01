import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAgentAddress,
  formatChannelAddress,
  formatTeamAddress,
  formatTeamMentionAddress,
  parseAddress,
} from "./types.js";

test("parseAddress supports team broadcast and mention formats", () => {
  assert.deepEqual(parseAddress("team:research"), {
    type: "team",
    teamName: "research",
  });
  assert.deepEqual(parseAddress("team:research:bob"), {
    type: "team-mention",
    teamName: "research",
    agentName: "bob",
  });
});

test("parseAddress rejects malformed team addresses", () => {
  assert.throws(() => parseAddress("team:"), /Invalid address format/);
  assert.throws(() => parseAddress("team::"), /Invalid address format/);
  assert.throws(() => parseAddress("team::bob"), /Invalid address format/);
  assert.throws(() => parseAddress("team:research:"), /Invalid address format/);
  assert.throws(() => parseAddress("team:a:b:c"), /Invalid address format/);
  assert.throws(() => parseAddress("team:INVALID!"), /Invalid address format/);
});

test("parseAddress keeps agent and channel behavior", () => {
  assert.deepEqual(parseAddress("agent:alice"), {
    type: "agent",
    agentName: "alice",
  });
  assert.deepEqual(parseAddress("channel:telegram:123"), {
    type: "channel",
    adapter: "telegram",
    chatId: "123",
  });
});

test("address formatters include new team helpers", () => {
  assert.equal(formatAgentAddress("alice"), "agent:alice");
  assert.equal(formatTeamAddress("research"), "team:research");
  assert.equal(formatTeamMentionAddress("research", "bob"), "team:research:bob");
  assert.equal(formatChannelAddress("telegram", "123"), "channel:telegram:123");
});
