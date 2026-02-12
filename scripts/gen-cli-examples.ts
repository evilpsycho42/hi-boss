import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createExampleFixture, runHibossCli, startExamplesDaemon } from "./examples/fixtures.js";

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

function writeDoc(params: { filename: string; title: string; command: string; output: string; note?: string }): void {
  const outPath = path.join(OUTPUT_DIR, params.filename);
  const doc = [
    `# ${params.title}`,
    "",
    "```bash",
    `$ ${params.command}`,
    "```",
    ...(params.note ? ["", params.note] : []),
    "",
    "```text",
    params.output.trimEnd(),
    "```",
    "",
  ].join("\n");
  fs.writeFileSync(outPath, doc, "utf-8");
  console.log(`  ${params.filename}`);
}

function writeRawDoc(params: { filename: string; contents: string }): void {
  const outPath = path.join(OUTPUT_DIR, params.filename);
  fs.writeFileSync(outPath, params.contents, "utf-8");
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
      filename: "daemon_status.DOC.md",
      title: "hiboss daemon status",
      command: "hiboss daemon status",
      output: await runOrThrow({ homeDir: fixture.homeDir, token: fixture.bossToken, args: ["daemon", "status"] }),
    });

    writeDoc({
      filename: "agent_list.DOC.md",
      title: "hiboss agent list",
      command: "hiboss agent list",
      output: await runOrThrow({ homeDir: fixture.homeDir, token: fixture.agentToken, args: ["agent", "list"] }),
    });

    {
      const sections: Array<{ title: string; cmd: string; args: string[] }> = [
        {
          title: "Example: private chat (channel)",
          cmd: "hiboss envelope list --from channel:telegram:789012 --status pending",
          args: ["envelope", "list", "--from", "channel:telegram:789012", "--status", "pending"],
        },
        {
          title: "Example: agent normal",
          cmd: "hiboss envelope list --from agent:scheduler --status pending",
          args: ["envelope", "list", "--from", "agent:scheduler", "--status", "pending"],
        },
        {
          title: "Example: agent scheduled + cron",
          cmd: "hiboss envelope list --from agent:nex --status pending",
          args: ["envelope", "list", "--from", "agent:nex", "--status", "pending"],
        },
        {
          title: "Example: group chat (channel)",
          cmd: "hiboss envelope list --from channel:telegram:-100123456789 --status pending",
          args: ["envelope", "list", "--from", "channel:telegram:-100123456789", "--status", "pending"],
        },
      ];

      const parts: string[] = [];
      parts.push("# hiboss envelope list", "");
      parts.push(
        "Note: `--status pending` with `--from` is treated as a work-queue read; returned envelopes are immediately acknowledged (at-most-once).",
        ""
      );

      for (const s of sections) {
        const output = await runOrThrow({ homeDir: fixture.homeDir, token: fixture.agentToken, args: s.args });
        parts.push(`## ${s.title}`, "");
        parts.push("```bash", `$ ${s.cmd}`, "```", "");
        parts.push("```text", output.trimEnd(), "```", "");
      }

      writeRawDoc({ filename: "envelope_list.DOC.md", contents: parts.join("\n") });
    }

    writeDoc({
      filename: "envelope_thread.DOC.md",
      title: "hiboss envelope thread",
      command: "hiboss envelope thread --envelope-id 9d0a61fe",
      output: await runOrThrow({
        homeDir: fixture.homeDir,
        token: fixture.agentToken,
        args: ["envelope", "thread", "--envelope-id", "9d0a61fe"],
      }),
    });

    writeDoc({
      filename: "cron_list.DOC.md",
      title: "hiboss cron list",
      command: "hiboss cron list",
      output: await runOrThrow({ homeDir: fixture.homeDir, token: fixture.agentToken, args: ["cron", "list"] }),
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
