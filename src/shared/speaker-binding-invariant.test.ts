import assert from "node:assert/strict";
import test from "node:test";
import {
  getSpeakerBindingIntegrity,
  hasSpeakerBindingIntegrityViolations,
  toSpeakerBindingIntegrityView,
} from "./speaker-binding-invariant.js";

test("detects speakers without bindings", () => {
  const integrity = getSpeakerBindingIntegrity({
    agents: [
      { name: "speaker-a", metadata: { role: "speaker" } },
      { name: "leader-a", metadata: { role: "leader" } },
    ],
    bindings: [],
  });

  assert.deepEqual(integrity.speakerWithoutBindings, ["speaker-a"]);
  assert.equal(integrity.duplicateSpeakerBindings.length, 0);
  assert.equal(hasSpeakerBindingIntegrityViolations(integrity), true);
});

test("detects duplicate adapter token shared by speakers", () => {
  const integrity = getSpeakerBindingIntegrity({
    agents: [
      { name: "speaker-a", metadata: { role: "speaker" } },
      { name: "speaker-b", metadata: { role: "speaker" } },
      { name: "leader-a", metadata: { role: "leader" } },
    ],
    bindings: [
      { agentName: "speaker-a", adapterType: "telegram", adapterToken: "123:abc" },
      { agentName: "speaker-b", adapterType: "telegram", adapterToken: "123:abc" },
    ],
  });

  assert.deepEqual(integrity.speakerWithoutBindings, []);
  assert.equal(integrity.duplicateSpeakerBindings.length, 1);
  assert.deepEqual(integrity.duplicateSpeakerBindings[0], {
    adapterType: "telegram",
    adapterToken: "123:abc",
    speakers: ["speaker-a", "speaker-b"],
  });
});

test("integrity view redacts adapter token", () => {
  const view = toSpeakerBindingIntegrityView({
    speakerWithoutBindings: [],
    duplicateSpeakerBindings: [
      {
        adapterType: "telegram",
        adapterToken: "123456789:ABCdef_123",
        speakers: ["speaker-a", "speaker-b"],
      },
    ],
  });

  assert.equal(view.duplicateSpeakerBindings.length, 1);
  assert.equal(view.duplicateSpeakerBindings[0]?.adapterTokenRedacted, "1234...23");
});

