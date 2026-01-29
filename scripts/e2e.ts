import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function readKey(out: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}:\\s*(.+)\\s*$`, "m");
  const match = out.match(re);
  return match?.[1]?.trim();
}

function parseKeyValueLines(out: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trimEnd();
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    result[key] = value;
  }
  return result;
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("<redacted>");
  }
  return out;
}

function runHiboss(
  hibossEntry: string,
  args: string[],
  env: NodeJS.ProcessEnv
): RunResult {
  const res = spawnSync(process.execPath, [hibossEntry, ...args], {
    env,
    cwd: process.cwd(),
    encoding: "utf8",
  });

  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function expectOk(result: RunResult, context: string, redactWith: string[] = []): void {
  if (result.code === 0) return;
  const details = redact(`${result.stdout}\n${result.stderr}`.trim(), redactWith);
  throw new Error(`${context} failed (exit ${result.code})\n${details}`);
}

function expectFail(result: RunResult, context: string, expectedSubstring: string, redactWith: string[] = []): void {
  if (result.code === 0) {
    throw new Error(`${context} unexpectedly succeeded`);
  }
  const output = redact(`${result.stdout}\n${result.stderr}`.trim(), redactWith);
  assert.ok(
    output.includes(expectedSubstring),
    `${context} expected error to include:\n${expectedSubstring}\n\nGot:\n${output}`
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  fn: () => boolean,
  options: { timeoutMs: number; intervalMs: number; context: string }
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    if (fn()) return;
    await sleep(options.intervalMs);
  }
  throw new Error(`Timed out: ${options.context}`);
}

async function main(): Promise<void> {
  const hibossEntry = path.resolve(process.cwd(), "dist/bin/hiboss.js");
  if (!fs.existsSync(hibossEntry)) {
    throw new Error("Missing dist build output. Run: npm run build");
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-e2e-"));
  const bossName = "e2e-boss";
  const bossToken = "boss-e2e";

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmpHome,
    HIBOSS_E2E: "1",
    MEM_CLI_DAEMON: "0",
  };
  const daemonLogPath = path.join(tmpHome, ".hiboss", "daemon.log");

  const setupConfigPath = path.join(tmpHome, "setup.json");
  const setupConfig = {
    version: 1,
    "boss-name": bossName,
    "boss-token": bossToken,
    provider: "codex",
    agent: {
      name: "nex",
      description: "nex - e2e",
      workspace: path.resolve(process.cwd()),
      model: "gpt-5.2",
      "reasoning-effort": "medium",
      "auto-level": "low",
      "permission-level": "standard",
      "session-policy": {
        "idle-timeout": "2s",
      },
    },
    telegram: {
      "adapter-token": "123456789:ABCdef_123",
      "adapter-boss-id": "boss",
    },
  };

  fs.writeFileSync(setupConfigPath, JSON.stringify(setupConfig, null, 2), "utf8");

  let agentToken = "";
  let restrictedAgentToken = "";
  const secretsToRedact: string[] = [bossToken];

  try {
    // Setup (non-interactive).
    const setupRes = runHiboss(hibossEntry, ["setup", "default", "--config", setupConfigPath], baseEnv);
    expectOk(setupRes, "setup default", secretsToRedact);

    agentToken = readKey(setupRes.stdout, "agent-token") ?? "";
    assert.ok(agentToken, "setup default did not output agent-token");
    secretsToRedact.push(agentToken);

    // Start daemon with auto-run disabled so we can test turn preview deterministically.
    const startNoAutoRun = runHiboss(
      hibossEntry,
      ["daemon", "start", "--token", bossToken, "--debug"],
      { ...baseEnv, HIBOSS_DISABLE_AGENT_AUTO_RUN: "1" }
    );
    expectOk(startNoAutoRun, "daemon start (no auto-run)", secretsToRedact);

    // Send two envelopes that should remain pending.
    const send1 = runHiboss(
      hibossEntry,
      ["envelope", "send", "--token", bossToken, "--to", "agent:nex", "--from", "agent:nex", "--from-boss", "--from-name", bossName, "--text", "hello-1"],
      baseEnv
    );
    expectOk(send1, "envelope send #1", secretsToRedact);
    const env1Id = readKey(send1.stdout, "id");
    assert.ok(env1Id, "envelope send #1 did not output id");

    const send2 = runHiboss(
      hibossEntry,
      ["envelope", "send", "--token", bossToken, "--to", "agent:nex", "--from", "agent:nex", "--from-boss", "--from-name", bossName, "--text", "hello-2"],
      baseEnv
    );
    expectOk(send2, "envelope send #2", secretsToRedact);

    // Pending inbox should contain both messages.
    const listPending = runHiboss(
      hibossEntry,
      ["envelope", "list", "--token", agentToken, "--box", "inbox", "--status", "pending"],
      baseEnv
    );
    expectOk(listPending, "envelope list pending", secretsToRedact);
    assert.ok(listPending.stdout.includes("hello-1"), "pending inbox missing hello-1");
    assert.ok(listPending.stdout.includes("hello-2"), "pending inbox missing hello-2");

    // Turn preview should include both messages.
    const asTurn = runHiboss(
      hibossEntry,
      [
        "envelope",
        "list",
        "--token",
        bossToken,
        "--as-turn",
        "--box",
        "inbox",
        "--status",
        "pending",
        "--address",
        "agent:nex",
      ],
      baseEnv
    );
    expectOk(asTurn, "envelope list --as-turn", secretsToRedact);
    assert.ok(asTurn.stdout.includes("## Turn Context"), "turn preview missing context header");
    assert.ok(asTurn.stdout.includes("## Pending Envelopes"), "turn preview missing envelopes section");
    assert.ok(asTurn.stdout.includes("hello-1"), "turn preview missing hello-1");
    assert.ok(asTurn.stdout.includes("hello-2"), "turn preview missing hello-2");

    // Stop daemon (no auto-run).
    const stopNoAutoRun = runHiboss(hibossEntry, ["daemon", "stop", "--token", bossToken], baseEnv);
    expectOk(stopNoAutoRun, "daemon stop (no auto-run)", secretsToRedact);

    // Restart daemon with auto-run enabled; startup recovery should process pending inbox.
    const startAutoRun = runHiboss(hibossEntry, ["daemon", "start", "--token", bossToken, "--debug"], baseEnv);
    expectOk(startAutoRun, "daemon start (auto-run)", secretsToRedact);

    await waitFor(
      () => {
        const res = runHiboss(
          hibossEntry,
          ["envelope", "list", "--token", agentToken, "--box", "inbox", "--status", "pending"],
          baseEnv
        );
        return res.code === 0 && res.stdout.includes("no-envelopes: true");
      },
      { timeoutMs: 10_000, intervalMs: 200, context: "agent should process startup pending inbox" }
    );

    // Scheduler: deliver-at should delay delivery until due.
    const scheduled = runHiboss(
      hibossEntry,
      [
        "envelope",
        "send",
        "--token",
        bossToken,
        "--to",
        "agent:nex",
        "--from",
        "agent:nex",
        "--from-boss",
        "--from-name",
        bossName,
        "--text",
        "scheduled-1",
        "--deliver-at",
        "+2s",
      ],
      baseEnv
    );
    expectOk(scheduled, "envelope send scheduled", secretsToRedact);

    const doneBeforeDue = runHiboss(
      hibossEntry,
      ["envelope", "list", "--token", agentToken, "--box", "inbox", "--status", "done"],
      baseEnv
    );
    expectOk(doneBeforeDue, "envelope list done (before due)", secretsToRedact);
    assert.ok(!doneBeforeDue.stdout.includes("scheduled-1"), "scheduled envelope delivered too early");

    await waitFor(
      () => {
        const res = runHiboss(
          hibossEntry,
          ["envelope", "list", "--token", agentToken, "--box", "inbox", "--status", "done"],
          baseEnv
        );
        return res.code === 0 && res.stdout.includes("scheduled-1");
      },
      { timeoutMs: 10_000, intervalMs: 200, context: "scheduled envelope should be delivered and processed" }
    );

    // Session policy: idle-timeout should trigger a refresh (log-level verification).
    await sleep(2500);
    const afterIdle = runHiboss(
      hibossEntry,
      ["envelope", "send", "--token", bossToken, "--to", "agent:nex", "--from", "agent:nex", "--text", "after-idle"],
      baseEnv
    );
    expectOk(afterIdle, "envelope send after idle", secretsToRedact);

    await waitFor(
      () => {
        const res = runHiboss(
          hibossEntry,
          ["envelope", "list", "--token", agentToken, "--box", "inbox", "--status", "pending"],
          baseEnv
        );
        return res.code === 0 && res.stdout.includes("no-envelopes: true");
      },
      { timeoutMs: 10_000, intervalMs: 200, context: "agent should process after-idle envelope" }
    );

    const daemonLog = fs.existsSync(daemonLogPath) ? fs.readFileSync(daemonLogPath, "utf8") : "";
    assert.ok(daemonLog.includes("idle-timeout-ms:2000"), "daemon log missing idle-timeout session refresh");
    assert.ok(daemonLog.includes("## Memory"), "daemon log missing memory section in generated system prompt");

    // Envelope rendering should preserve boss marker.
    const getEnv1 = runHiboss(hibossEntry, ["envelope", "get", "--token", agentToken, "--id", env1Id], baseEnv);
    expectOk(getEnv1, "envelope get #1", secretsToRedact);
    assert.ok(getEnv1.stdout.includes(`from-name: ${bossName} [boss]`), "boss marker missing in from-name");

    // Daemon status should be parseable and show running=true.
    const status = runHiboss(hibossEntry, ["daemon", "status", "--token", bossToken], baseEnv);
    expectOk(status, "daemon status", secretsToRedact);
    const parsedStatus = parseKeyValueLines(status.stdout);
    assert.equal(parsedStatus["running"], "true");
    assert.equal(parsedStatus["debug"], "enabled");
    assert.ok(parsedStatus["data-dir"]?.endsWith(".hiboss"), "daemon status missing data-dir");

    // Permission checks: agent token cannot call boss-only daemon.status.
    const statusDenied = runHiboss(hibossEntry, ["daemon", "status", "--token", agentToken], baseEnv);
    expectFail(statusDenied, "daemon status with agent token", "Access denied", secretsToRedact);

    // Validation: parse-mode / reply-to should be rejected for agent destinations.
    const parseModeDenied = runHiboss(
      hibossEntry,
      ["envelope", "send", "--token", bossToken, "--to", "agent:nex", "--from", "agent:nex", "--text", "x", "--parse-mode", "plain"],
      baseEnv
    );
    expectFail(parseModeDenied, "envelope send parse-mode to agent", "parse-mode is only supported for channel destinations", secretsToRedact);

    const replyToDenied = runHiboss(
      hibossEntry,
      ["envelope", "send", "--token", bossToken, "--to", "agent:nex", "--from", "agent:nex", "--text", "x", "--reply-to", "123"],
      baseEnv
    );
    expectFail(replyToDenied, "envelope send reply-to to agent", "reply-to-message-id is only supported for channel destinations", secretsToRedact);

    // Validation: agent token cannot impersonate sender.
    const agentFromDenied = runHiboss(
      hibossEntry,
      ["envelope", "send", "--token", agentToken, "--to", "agent:nex", "--from", "agent:nex", "--text", "x"],
      baseEnv
    );
    expectFail(agentFromDenied, "agent envelope send --from", "Access denied", secretsToRedact);

    // Register a restricted agent and validate background permission.
    const registerRestricted = runHiboss(
      hibossEntry,
      [
        "agent",
        "register",
        "--token",
        bossToken,
        "--name",
        "zed",
        "--description",
        "zed - e2e restricted",
        "--workspace",
        path.resolve(process.cwd()),
        "--permission-level",
        "restricted",
        "--provider",
        "codex",
      ],
      baseEnv
    );
    expectOk(registerRestricted, "agent register (restricted)", secretsToRedact);
    restrictedAgentToken = readKey(registerRestricted.stdout, "token") ?? "";
    assert.ok(restrictedAgentToken, "agent register did not output token");
    secretsToRedact.push(restrictedAgentToken);

    const bgDenied = runHiboss(
      hibossEntry,
      ["background", "--token", restrictedAgentToken, "--task", "background-task"],
      baseEnv
    );
    expectFail(bgDenied, "background (restricted agent)", "Access denied", secretsToRedact);

    // Background task as standard agent should enqueue a self-envelope (mocked in HIBOSS_E2E mode).
    const bgOk = runHiboss(
      hibossEntry,
      ["background", "--token", agentToken, "--task", "background-task-ok"],
      baseEnv
    );
    expectOk(bgOk, "background (standard agent)", secretsToRedact);

    await waitFor(
      () => {
        const res = runHiboss(
          hibossEntry,
          ["envelope", "list", "--token", agentToken, "--box", "inbox", "--status", "done"],
          baseEnv
        );
        return res.code === 0 && res.stdout.includes("[HIBOSS_E2E mock] background-task-ok");
      },
      { timeoutMs: 10_000, intervalMs: 200, context: "background result should appear in done inbox" }
    );

    // Memory surface smoke test (no downloads).
    const memState = runHiboss(
      hibossEntry,
      ["mem", "state"],
      { ...baseEnv, HIBOSS_TOKEN: agentToken }
    );
    expectOk(memState, "mem state", secretsToRedact);
    assert.ok(memState.stdout.includes("Type: private"), "mem state missing Type: private");

    console.log("e2e: ok");
  } finally {
    // Best-effort shutdown + cleanup.
    runHiboss(hibossEntry, ["daemon", "stop", "--token", bossToken], baseEnv);
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error("e2e: failed");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
