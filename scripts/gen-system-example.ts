import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { buildSystemPromptContext } from "../src/shared/prompt-context.js";
import { renderPrompt } from "../src/shared/prompt-renderer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOC_FILE = path.resolve(__dirname, "../prompts/system/system.DOC.md");

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
  hibossDir: "~/.hiboss",
});

const rendered = renderPrompt({
  surface: "system",
  template: "system/base.md",
  context: promptContext,
});

// Read the current DOC file
const docContent = fs.readFileSync(DOC_FILE, "utf-8");

// Find and replace the Full Example section
const exampleHeader = "## Full Example";
const headerIndex = docContent.indexOf(exampleHeader);

if (headerIndex === -1) {
  console.error("Could not find '## Full Example' section in system.DOC.md");
  process.exit(1);
}

// Build the new example section
const newExampleSection = `${exampleHeader}

\`\`\`\`\`text
${rendered.trim()}
\`\`\`\`\`
`;

// Replace everything from "## Full Example" to end of file
const updatedContent = docContent.slice(0, headerIndex) + newExampleSection;

fs.writeFileSync(DOC_FILE, updatedContent, "utf-8");

console.log(`Updated ${DOC_FILE} with generated system prompt example.`);
