import { runBackgroundTask } from "./agent/background-task.js";

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function requireArg(flag: string): string {
  const value = getArgValue(flag);
  if (!value) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return value;
}

async function main(): Promise<void> {
  const agentName = requireArg("--agent-name");
  const providerRaw = requireArg("--provider");
  const workspace = requireArg("--workspace");
  const reasoningEffortRaw = requireArg("--reasoning-effort");
  const autoLevelRaw = requireArg("--auto-level");
  const task = requireArg("--task");
  const model = getArgValue("--model");

  if (providerRaw !== "claude" && providerRaw !== "codex") {
    throw new Error(`Invalid --provider: ${providerRaw}`);
  }

  if (
    reasoningEffortRaw !== "none" &&
    reasoningEffortRaw !== "low" &&
    reasoningEffortRaw !== "medium" &&
    reasoningEffortRaw !== "high" &&
    reasoningEffortRaw !== "xhigh"
  ) {
    throw new Error(`Invalid --reasoning-effort: ${reasoningEffortRaw}`);
  }

  if (autoLevelRaw !== "low" && autoLevelRaw !== "medium" && autoLevelRaw !== "high") {
    throw new Error(`Invalid --auto-level: ${autoLevelRaw}`);
  }

  await runBackgroundTask({
    agentName,
    provider: providerRaw,
    workspace,
    model: model ?? undefined,
    reasoningEffort: reasoningEffortRaw,
    autoLevel: autoLevelRaw,
    task,
  });
}

main().catch((err) => {
  console.error("[background-agent] error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

