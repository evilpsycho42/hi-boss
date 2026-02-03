import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createExampleFixture, runHibossCli, startExamplesDaemon } from "./examples/fixtures.js";

process.env.TZ ??= "UTC";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.resolve(__dirname, "../examples/cli");

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

function writeDoc(params: { filename: string; title: string; command: string; output: string }): void {
  const outPath = path.join(OUTPUT_DIR, params.filename);
  const doc = [
    `# ${params.title}`,
    "",
    "```bash",
    `$ ${params.command}`,
    "```",
    "",
    "```text",
    params.output.trimEnd(),
    "```",
    "",
  ].join("\n");
  fs.writeFileSync(outPath, doc, "utf-8");
  console.log(`  ${params.filename}`);
}

async function runOrThrow(params: { homeDir: string; token: string; args: string[] }): Promise<string> {
  const res = await runHibossCli(params);
  if (res.status !== 0) {
    const cmd = `hiboss ${params.args.join(" ")}`;
    const err = (res.stderr || res.stdout || "").trim() || "(no output)";
    throw new Error(`Command failed (${res.status}): ${cmd}\n${err}`);
  }
  return res.stdout;
}

async function main(): Promise<void> {
  ensureOutputDir(OUTPUT_DIR);
  clearOldExampleDocs(OUTPUT_DIR);

  console.log("Generating CLI command output examples (e2e)...");

  const fixture = await createExampleFixture();
  const handle = await startExamplesDaemon(fixture.hibossDir);

  try {
    writeDoc({
      filename: "agent_list.DOC.md",
      title: "hiboss agent list",
      command: "hiboss agent list",
      output: await runOrThrow({ homeDir: fixture.homeDir, token: fixture.agentToken, args: ["agent", "list"] }),
    });

    writeDoc({
      filename: "envelope_list.DOC.md",
      title: "hiboss envelope list",
      command: "hiboss envelope list --from channel:telegram:-100123456789 --status pending",
      output: await runOrThrow({
        homeDir: fixture.homeDir,
        token: fixture.agentToken,
        args: ["envelope", "list", "--from", "channel:telegram:-100123456789", "--status", "pending"],
      }),
    });

    writeDoc({
      filename: "cron_list.DOC.md",
      title: "hiboss cron list",
      command: "hiboss cron list",
      output: await runOrThrow({ homeDir: fixture.homeDir, token: fixture.agentToken, args: ["cron", "list"] }),
    });

    writeDoc({
      filename: "memory_categories.DOC.md",
      title: "hiboss memory categories",
      command: "hiboss memory categories",
      output: await runOrThrow({
        homeDir: fixture.homeDir,
        token: fixture.agentToken,
        args: ["memory", "categories"],
      }),
    });

    writeDoc({
      filename: "memory_list.DOC.md",
      title: "hiboss memory list",
      command: "hiboss memory list",
      output: await runOrThrow({
        homeDir: fixture.homeDir,
        token: fixture.agentToken,
        args: ["memory", "list"],
      }),
    });

    console.log("\n---");
    console.log("Generated 5 CLI output examples");
  } finally {
    await handle.stop().catch(() => undefined);
    fixture.cleanup();
  }
}

main().catch((err) => {
  console.error("error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
