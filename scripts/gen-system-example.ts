import { buildSystemPromptContext } from "../src/shared/prompt-context.js";
import { renderPrompt } from "../src/shared/prompt-renderer.js";

const mockAgent = {
  id: 1,
  name: "nex",
  description: "AI assistant for project management",
  workspace: "/home/user/projects/myapp",
  provider: "claude",
  model: "claude-sonnet-4-20250514",
  createdAt: "2025-01-15T10:30:00.000Z",
  lastSeenAt: "2025-01-29T14:22:00.000Z",
};

const mockBindings = [
  { agentId: 1, adapterType: "telegram", createdAt: "2025-01-15T11:00:00.000Z" },
];

const mockBoss = {
  name: "Kevin",
  adapterIds: { telegram: "@kky1024" },
};

const promptContext = buildSystemPromptContext({
  agent: mockAgent as any,
  agentToken: "agt_abc123xyz...",
  bindings: mockBindings as any,
  boss: mockBoss,
});

const rendered = renderPrompt({
  surface: "system",
  template: "system/base.md",
  context: promptContext,
});

console.log(rendered);
