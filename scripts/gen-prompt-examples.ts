import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { HiBossDatabase } from "../src/daemon/db/database.js";
import { buildSystemPromptContext, buildTurnPromptContext } from "../src/shared/prompt-context.js";
import { renderPrompt } from "../src/shared/prompt-renderer.js";

import { createExampleFixture } from "./examples/fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.resolve(__dirname, "../examples/prompts");

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

async function main(): Promise<void> {
  ensureOutputDir(OUTPUT_DIR);
  clearOldExampleDocs(OUTPUT_DIR);

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

        const rendered = renderPrompt({
          surface: "system",
          template: "system/base.md",
          context: promptContext,
        });

        const filename = `system_example_${permissionLevel}_${adapterConfig.name}.DOC.md`;
        fs.writeFileSync(path.join(OUTPUT_DIR, filename), rendered.trim() + "\n", "utf-8");
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

    fs.writeFileSync(path.join(OUTPUT_DIR, "turn_example.DOC.md"), turnRendered.trim() + "\n", "utf-8");
    console.log("  turn_example.DOC.md");

    console.log("\n---");
    console.log(`Generated ${permissionLevels.length * adapterConfigs.length} system prompt examples`);
    console.log("Generated 1 turn prompt example");
  } finally {
    db.close();
    fixture.cleanup();
  }
}

main().catch((err) => {
  console.error("error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
