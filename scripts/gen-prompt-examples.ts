import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  buildSystemPromptContext,
  buildTurnPromptContext,
  buildCliEnvelopePromptContext,
} from "../src/shared/prompt-context.js";
import { renderPrompt } from "../src/shared/prompt-renderer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.resolve(__dirname, "../prompts/examples");

function ensureOutputDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function clearOldExampleDocs(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".DOC.md")) continue;
    fs.rmSync(path.join(dir, entry.name));
  }
}

ensureOutputDir(OUTPUT_DIR);
clearOldExampleDocs(OUTPUT_DIR);

// =============================================================================
// System Prompt Examples
// =============================================================================

const permissionLevels = ["restricted", "standard", "privileged", "boss"] as const;
const adapterConfigs = [
  { name: "none", bindings: [] },
  { name: "telegram", bindings: [{ agentId: 1, adapterType: "telegram", createdAt: "2025-01-15T11:00:00.000Z" }] },
] as const;

const baseAgent = {
  id: 1,
  name: "nex",
  description: "AI assistant for project management",
  workspace: "/home/user/projects/myapp",
  provider: "claude",
  model: "claude-sonnet-4-20250514",
  createdAt: "2025-01-15T10:30:00.000Z",
  lastSeenAt: "2025-01-29T14:22:00.000Z",
};

const mockBoss = {
  name: "Kevin",
  adapterIds: { telegram: "@kky1024" },
};

console.log("Generating system prompt examples...");

for (const permissionLevel of permissionLevels) {
  for (const adapterConfig of adapterConfigs) {
    const agent = { ...baseAgent, permissionLevel };
    const bindings = adapterConfig.bindings as any;

    const promptContext = buildSystemPromptContext({
      agent: agent as any,
      agentToken: "agt_abc123xyz...",
      bindings,
      boss: mockBoss,
      hibossDir: "~/.hiboss",
    });

    const rendered = renderPrompt({
      surface: "system",
      template: "system/base.md",
      context: promptContext,
    });

    const filename = `system_example_${permissionLevel}_${adapterConfig.name}.DOC.md`;
    const outputPath = path.join(OUTPUT_DIR, filename);

    fs.writeFileSync(outputPath, rendered.trim() + "\n", "utf-8");
    console.log(`  ${filename}`);
  }
}

// =============================================================================
// Turn Prompt Example
// =============================================================================

console.log("\nGenerating turn prompt example...");

const mockEnvelopes = [
  {
    id: "env_001",
    from: "channel:telegram:-100123456789",
    to: "agent:nex",
    fromBoss: true,
    createdAt: "2025-01-29T08:30:00.000Z",
    content: {
      text: "Hey nex, can you check the build status?",
      attachments: [],
    },
    metadata: {
      platform: "telegram",
      channelMessageId: "1001",
      author: { id: "123", username: "kky1024", displayName: "Kevin" },
      chat: { id: "-100123456789", name: "Project X Dev" },
    },
  },
  {
    id: "env_002",
    from: "channel:telegram:-100123456789",
    to: "agent:nex",
    fromBoss: false,
    createdAt: "2025-01-29T08:31:00.000Z",
    content: {
      text: "I think CI is broken again",
      attachments: [],
    },
    metadata: {
      platform: "telegram",
      channelMessageId: "1002",
      author: { id: "456", username: "alice_dev", displayName: "Alice" },
      chat: { id: "-100123456789", name: "Project X Dev" },
    },
  },
  {
    id: "env_003",
    from: "channel:telegram:789012",
    to: "agent:nex",
    fromBoss: true,
    createdAt: "2025-01-29T08:35:00.000Z",
    content: {
      text: "Also, remind me to review the PR at 3pm",
      attachments: [],
    },
    metadata: {
      platform: "telegram",
      channelMessageId: "2001",
      author: { id: "123", username: "kky1024", displayName: "Kevin" },
      chat: { id: "789012" },
    },
  },
  {
    id: "env_004",
    from: "agent:assistant",
    to: "agent:nex",
    fromBoss: false,
    createdAt: "2025-01-29T08:40:00.000Z",
    content: {
      text: "FYI: The database backup completed successfully.",
      attachments: [],
    },
    metadata: {
      fromName: "assistant",
    },
  },
];

const turnContext = buildTurnPromptContext({
  agentName: "nex",
  datetimeIso: "2025-01-29T08:45:00.000Z",
  envelopes: mockEnvelopes as any,
});

const turnRendered = renderPrompt({
  surface: "turn",
  template: "turn/turn.md",
  context: turnContext,
});

const turnOutputPath = path.join(OUTPUT_DIR, "turn_example.DOC.md");
fs.writeFileSync(turnOutputPath, turnRendered.trim() + "\n", "utf-8");
console.log(`  turn_example.DOC.md`);

// =============================================================================
// Envelope Prompt Example
// =============================================================================

console.log("\nGenerating envelope prompt examples...");

// Direct message from boss
const directEnvelope = {
  id: "env_direct_001",
  from: "channel:telegram:789012",
  to: "agent:nex",
  fromBoss: true,
  createdAt: "2025-01-29T09:00:00.000Z",
  content: {
    text: "Can you summarize the meeting notes from yesterday?",
    attachments: [
      { source: "/home/user/downloads/meeting-notes.pdf", filename: "meeting-notes.pdf" },
    ],
  },
  metadata: {
    platform: "telegram",
    channelMessageId: "3001",
    author: { id: "123", username: "kky1024", displayName: "Kevin" },
    chat: { id: "789012" },
  },
};

const directEnvelopeContext = buildCliEnvelopePromptContext({
  envelope: directEnvelope as any,
});

const directEnvelopeRendered = renderPrompt({
  surface: "envelope",
  template: "envelope/instruction.md",
  context: directEnvelopeContext,
});

const directEnvelopePath = path.join(OUTPUT_DIR, "envelope_example_direct.DOC.md");
fs.writeFileSync(directEnvelopePath, directEnvelopeRendered.trim() + "\n", "utf-8");
console.log(`  envelope_example_direct.DOC.md`);

// Group message
const groupEnvelope = {
  id: "env_group_001",
  from: "channel:telegram:-100123456789",
  to: "agent:nex",
  fromBoss: false,
  createdAt: "2025-01-29T09:15:00.000Z",
  content: {
    text: "@nex what's the ETA on the feature?",
    attachments: [],
  },
  metadata: {
    platform: "telegram",
    channelMessageId: "4001",
    author: { id: "456", username: "alice_dev", displayName: "Alice" },
    chat: { id: "-100123456789", name: "Project X Dev" },
  },
};

const groupEnvelopeContext = buildCliEnvelopePromptContext({
  envelope: groupEnvelope as any,
});

const groupEnvelopeRendered = renderPrompt({
  surface: "envelope",
  template: "envelope/instruction.md",
  context: groupEnvelopeContext,
});

const groupEnvelopePath = path.join(OUTPUT_DIR, "envelope_example_group.DOC.md");
fs.writeFileSync(groupEnvelopePath, groupEnvelopeRendered.trim() + "\n", "utf-8");
console.log(`  envelope_example_group.DOC.md`);

// Agent-to-agent message
const agentEnvelope = {
  id: "env_agent_001",
  from: "agent:scheduler",
  to: "agent:nex",
  fromBoss: false,
  createdAt: "2025-01-29T09:30:00.000Z",
  deliverAt: "2025-01-29T15:00:00.000Z",
  content: {
    text: "Reminder: Review the PR as requested by Kevin.",
    attachments: [],
  },
  metadata: {
    fromName: "scheduler",
  },
};

const agentEnvelopeContext = buildCliEnvelopePromptContext({
  envelope: agentEnvelope as any,
});

const agentEnvelopeRendered = renderPrompt({
  surface: "envelope",
  template: "envelope/instruction.md",
  context: agentEnvelopeContext,
});

const agentEnvelopePath = path.join(OUTPUT_DIR, "envelope_example_agent.DOC.md");
fs.writeFileSync(agentEnvelopePath, agentEnvelopeRendered.trim() + "\n", "utf-8");
console.log(`  envelope_example_agent.DOC.md`);

// Summary
console.log("\n---");
console.log(`Generated ${permissionLevels.length * adapterConfigs.length} system prompt examples`);
console.log(`Generated 1 turn prompt example`);
console.log(`Generated 3 envelope prompt examples`);
