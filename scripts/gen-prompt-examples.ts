import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { HiBossDatabase } from "../src/daemon/db/database.js";
import { buildCliEnvelopePromptContext, buildSystemPromptContext, buildTurnPromptContext } from "../src/shared/prompt-context.js";
import { renderPrompt } from "../src/shared/prompt-renderer.js";
import { ensureAgentInternalSpaceLayout, readAgentInternalMemorySnapshot } from "../src/shared/internal-space.js";

import { createExampleFixture } from "./examples/fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIRS = [
  path.resolve(__dirname, "../examples/prompts"),
  path.resolve(__dirname, "../prompts/examples"),
] as const;

function ensureOutputDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function clearOldExampleDocs(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".DOC.md")) continue;
    fs.rmSync(path.join(dir, entry.name));
  }
}

function writeExampleDoc(params: { dir: string; filename: string; contents: string }): void {
  fs.writeFileSync(
    path.join(params.dir, params.filename),
    params.contents.trim() + "\n",
    "utf-8"
  );
}

function chooseFence(text: string): string {
  let fence = "```";
  while (text.includes(fence)) {
    fence += "`";
  }
  return fence;
}

async function main(): Promise<void> {
  for (const dir of OUTPUT_DIRS) {
    ensureOutputDir(dir);
    clearOldExampleDocs(dir);
  }

  const fixture = await createExampleFixture();
  const db = new HiBossDatabase(path.join(fixture.hibossDir, "hiboss.db"));

  try {
    const agent = db.getAgentByName("nex");
    if (!agent) throw new Error("Missing fixture agent: nex");

    const bindings = db.getBindingsByAgentName("nex");
    const bossName = db.getBossName() ?? "";
    const bossTelegramId = db.getAdapterBossId("telegram") ?? "";
    const bossTimezone = db.getBossTimezone();

    // =============================================================================
    // System prompt examples
    // =============================================================================

    const permissionLevels = ["restricted", "standard", "privileged", "boss"] as const;
    const adapterConfigs = [
      { name: "none", bindings: [] as typeof bindings },
      { name: "telegram", bindings },
    ] as const;

    console.log("Generating system prompt examples (e2e fixture)...");

    for (const permissionLevel of permissionLevels) {
      for (const adapterConfig of adapterConfigs) {
        const promptContext = buildSystemPromptContext({
          agent: { ...agent, permissionLevel },
          agentToken: fixture.agentToken,
          bindings: adapterConfig.bindings,
          time: { bossTimezone },
          boss: { name: bossName, adapterIds: { telegram: bossTelegramId } },
          hibossDir: fixture.hibossDir,
        });

        // Mirror real session behavior: best-effort inject a snapshot of internal_space/MEMORY.md.
        const spaceContext = promptContext.internalSpace as Record<string, unknown>;
        const ensured = ensureAgentInternalSpaceLayout({ hibossDir: fixture.hibossDir, agentName: agent.name });
        if (!ensured.ok) {
          spaceContext.note = "";
          spaceContext.noteFence = "```";
          spaceContext.error = ensured.error;
        } else {
          const snapshot = readAgentInternalMemorySnapshot({ hibossDir: fixture.hibossDir, agentName: agent.name });
          if (snapshot.ok) {
            spaceContext.note = snapshot.note;
            spaceContext.noteFence = chooseFence(snapshot.note);
            spaceContext.error = "";
          } else {
            spaceContext.note = "";
            spaceContext.noteFence = "```";
            spaceContext.error = snapshot.error;
          }
        }

        const rendered = renderPrompt({
          surface: "system",
          template: "system/base.md",
          context: promptContext,
        });

        const filename = `system_example_${permissionLevel}_${adapterConfig.name}.DOC.md`;
        for (const dir of OUTPUT_DIRS) {
          writeExampleDoc({ dir, filename, contents: rendered });
        }
        console.log(`  ${filename}`);
      }
    }

    // =============================================================================
    // Turn prompt example
    // =============================================================================

    console.log("\nGenerating turn prompt example (e2e fixture)...");

    const turnEnvelopeIds = [
      // 3 messages from the same Telegram group
      "env_group_003",
      "env_group_002",
      "env_group_001",

      // 2 messages: one private chat + one other group
      "env_direct_001",
      "env_group_other_001",

      // 1 agent message
      "env_agent_001",

      // 1 message from a cron schedule
      "9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",

      // 1 delayed self-message
      "env_self_delayed_001",
    ] as const;

    const envelopes = turnEnvelopeIds.map((id) => {
      const env = db.getEnvelopeById(id);
      if (!env) throw new Error(`Missing fixture envelope for turn example: ${id}`);
      return env;
    });

    const turnContext = buildTurnPromptContext({
      agentName: "nex",
      datetimeMs: Date.parse("2026-01-29T08:45:00.000Z"),
      bossTimezone,
      envelopes,
    });

    const turnRendered = renderPrompt({
      surface: "turn",
      template: "turn/turn.md",
      context: turnContext,
    });

    for (const dir of OUTPUT_DIRS) {
      writeExampleDoc({ dir, filename: "turn_example.DOC.md", contents: turnRendered });
    }
    console.log("  turn_example.DOC.md");

    // =============================================================================
    // CLI envelope instruction examples
    // =============================================================================

    console.log("\nGenerating envelope instruction examples (e2e fixture)...");

    const envelopeExamples = [
      { id: "env_direct_001", filename: "envelope_example_direct.DOC.md" },
      { id: "env_group_001", filename: "envelope_example_group.DOC.md" },
      { id: "env_agent_001", filename: "envelope_example_agent.DOC.md" },
      { id: "9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d", filename: "envelope_example_cron.DOC.md" },
    ] as const;

    for (const ex of envelopeExamples) {
      const env = db.getEnvelopeById(ex.id);
      if (!env) throw new Error(`Missing fixture envelope for envelope example: ${ex.id}`);

      const ctx = buildCliEnvelopePromptContext({ envelope: env, bossTimezone });
      const rendered = renderPrompt({
        surface: "cli-envelope",
        template: "envelope/instruction.md",
        context: ctx,
      });

      for (const dir of OUTPUT_DIRS) {
        writeExampleDoc({ dir, filename: ex.filename, contents: rendered });
      }
      console.log(`  ${ex.filename}`);
    }

    console.log("\n---");
    console.log(`Generated ${permissionLevels.length * adapterConfigs.length} system prompt examples`);
    console.log("Generated 1 turn prompt example");
    console.log(`Generated ${envelopeExamples.length} envelope instruction examples`);
  } finally {
    db.close();
    fixture.cleanup();
  }
}

main().catch((err) => {
  console.error("error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
