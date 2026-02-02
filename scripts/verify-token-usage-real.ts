import { createRuntime } from "@unified-agent-sdk/runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type Provider = "claude" | "codex";
type SessionMode = "fresh" | "continuous";

type UsageLike = {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  context_length?: number;
};

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] ?? "";
    if (!raw.startsWith("--")) continue;

    const eq = raw.indexOf("=");
    if (eq !== -1) {
      args.set(raw.slice(2, eq), raw.slice(eq + 1));
      continue;
    }

    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(key, next);
      i++;
      continue;
    }
    args.set(key, "true");
  }

  const providerRaw = (args.get("provider") ?? "both").trim();
  const provider: Provider[] =
    providerRaw === "claude"
      ? ["claude"]
      : providerRaw === "codex"
        ? ["codex"]
        : ["claude", "codex"];

  const sessionModeRaw = (args.get("session-mode") ?? "fresh").trim();
  const sessionMode: SessionMode =
    sessionModeRaw === "continuous"
      ? "continuous"
      : sessionModeRaw === "fresh"
        ? "fresh"
        : (() => {
            throw new Error(`Invalid --session-mode ${sessionModeRaw} (expected fresh|continuous)`);
          })();

  const runsRaw = args.get("turns") ?? args.get("runs") ?? "2";
  const runs = Number(runsRaw);
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) {
    throw new Error(`Invalid --turns/--runs ${runsRaw} (expected integer 1-20)`);
  }

  const fillerWordsRaw = args.get("filler-words") ?? "1200";
  const fillerWords = Number(fillerWordsRaw);
  if (!Number.isInteger(fillerWords) || fillerWords < 0 || fillerWords > 20_000) {
    throw new Error(`Invalid --filler-words ${fillerWordsRaw} (expected integer 0-20000)`);
  }

  const prompt =
    args.get("prompt") ??
    "Respond with exactly 'OK' (uppercase), and nothing else.";

  const keepWorkspace = (args.get("keep-workspace") ?? "false") === "true";

  const claudeModel = args.get("claude-model") ?? undefined;
  const codexModel = args.get("codex-model") ?? undefined;

  const claudeHome = args.get("claude-home") ?? undefined;
  const codexHome = args.get("codex-home") ?? undefined;

  return {
    provider,
    sessionMode,
    runs,
    fillerWords,
    prompt,
    keepWorkspace,
    claudeModel,
    codexModel,
    claudeHome,
    codexHome,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readUsageNumbers(usage: unknown) {
  const u = (usage ?? {}) as UsageLike;
  const input = isFiniteNumber(u.input_tokens) ? u.input_tokens : null;
  const output = isFiniteNumber(u.output_tokens) ? u.output_tokens : null;
  const total = isFiniteNumber(u.total_tokens) ? u.total_tokens : null;
  const cacheRead = isFiniteNumber(u.cache_read_tokens) ? u.cache_read_tokens : null;
  const cacheWrite = isFiniteNumber(u.cache_write_tokens) ? u.cache_write_tokens : null;
  const contextLength = isFiniteNumber(u.context_length) ? u.context_length : null;

  return { input, output, total, cacheRead, cacheWrite, contextLength };
}

function checkInvariants(usage: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const { input, output, total, cacheRead, cacheWrite, contextLength } = readUsageNumbers(usage);

  if (input !== null && output !== null && total !== null) {
    if (total !== input + output) {
      errors.push(`total_tokens mismatch: expected ${input + output}, got ${total}`);
    }
  }

  if (input !== null && output !== null && contextLength !== null) {
    if (contextLength !== input + output) {
      errors.push(`context_length mismatch: expected ${input + output}, got ${contextLength}`);
    }
  }

  if (input !== null && cacheRead !== null && cacheRead > input) {
    errors.push(`cache_read_tokens must be <= input_tokens (got ${cacheRead} > ${input})`);
  }

  if (input !== null && cacheWrite !== null && cacheWrite > input) {
    errors.push(`cache_write_tokens must be <= input_tokens (got ${cacheWrite} > ${input})`);
  }

  return { ok: errors.length === 0, errors };
}

function hasAnyUsageNumbers(usage: unknown): boolean {
  const { input, output, total, cacheRead, cacheWrite, contextLength } = readUsageNumbers(usage);
  return (
    input !== null ||
    output !== null ||
    total !== null ||
    cacheRead !== null ||
    cacheWrite !== null ||
    contextLength !== null
  );
}

function buildFiller(words: number): string {
  if (words <= 0) return "";
  // Use a deterministic token-like stream to encourage prompt caching without being semantic.
  const token = "lorem";
  return Array.from({ length: words }, () => token).join(" ");
}

async function createTempWorkspace(fillerWords: number, keepWorkspace: boolean): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hiboss-usage-verify-"));

  const filler = buildFiller(fillerWords);
  const common = [
    "# Token usage verification workspace",
    "",
    "The next block is filler to encourage provider prompt caching and does not contain instructions.",
    "Ignore the filler; the only instruction is at the end of this file.",
    "",
    "BEGIN-FILLER",
    filler,
    "END-FILLER",
    "",
    "Instruction: Respond with exactly OK.",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  await Promise.all([
    fs.writeFile(path.join(dir, "AGENTS.md"), common, "utf8"),
    fs.writeFile(path.join(dir, "CLAUDE.md"), common, "utf8"),
  ]);

  const cleanup = async () => {
    if (keepWorkspace) return;
    await fs.rm(dir, { recursive: true, force: true });
  };

  return { dir, cleanup };
}

async function runProvider(options: {
  provider: Provider;
  sessionMode: SessionMode;
  runs: number;
  workspaceDir: string;
  prompt: string;
  model?: string;
  providerHomeOverride?: string;
}): Promise<{ allOk: boolean; sawAnyCacheTokens: boolean }> {
  const defaultOpts = {
    workspace: { cwd: options.workspaceDir },
    access: { auto: "low" as const },
    reasoningEffort: "low" as const,
    model: options.model,
  };

  const providerHome =
    options.providerHomeOverride ??
    (options.provider === "claude"
      ? path.join(os.homedir(), ".claude")
      : path.join(os.homedir(), ".codex"));

  const runtime =
    options.provider === "claude"
      ? createRuntime({
          provider: "@anthropic-ai/claude-agent-sdk",
          home: providerHome,
          defaultOpts,
        })
      : createRuntime({
          provider: "@openai/codex-sdk",
          home: providerHome,
          defaultOpts,
        });

  let allOk = true;
  let sawAnyCacheTokens = false;

  try {
    console.log(`provider: ${options.provider}`);
    console.log(`session-mode: ${options.sessionMode}`);
    console.log(`provider-home: ${providerHome}`);
    console.log(`runs: ${options.runs}`);
    if (options.model) console.log(`model: ${options.model}`);

    if (options.sessionMode === "continuous") {
      const session = await runtime.openSession({});
      let prev: ReturnType<typeof readUsageNumbers> | null = null;
      try {
        for (let i = 0; i < options.runs; i++) {
          const runIndex = i + 1;
          const turnPrompt = `${options.prompt}\n\n(turn ${runIndex}/${options.runs})`;

          const errorEvents: { message: string; code?: string }[] = [];
          const handle = await session.run({
            input: { parts: [{ type: "text", text: turnPrompt }] },
          });

          for await (const event of handle.events) {
            if (event.type === "error") {
              errorEvents.push({ message: event.message, code: event.code });
            }
          }

          const result = await handle.result;

          const usage = (result.usage ?? {}) as Record<string, unknown>;
          const { input, output, total, cacheRead, cacheWrite, contextLength } =
            readUsageNumbers(usage);
          const breakdownAvailable = hasAnyUsageNumbers(usage);
          const { ok, errors } = checkInvariants(usage);

          if ((cacheRead ?? 0) > 0 || (cacheWrite ?? 0) > 0) {
            sawAnyCacheTokens = true;
          }

          console.log(`run: ${runIndex}`);
          console.log(`status: ${result.status}`);
          if (result.status !== "success") {
            allOk = false;
            if (errorEvents.length > 0) {
              for (const err of errorEvents) {
                console.log(`run-error: ${err.code ? `${err.code}: ` : ""}${err.message}`);
              }
            }
          }
          console.log(`input-tokens: ${input ?? "n/a"}`);
          console.log(`output-tokens: ${output ?? "n/a"}`);
          console.log(`context-length: ${contextLength ?? "n/a"}`);
          console.log(`cache-read-tokens: ${cacheRead ?? "n/a"}`);
          console.log(`cache-write-tokens: ${cacheWrite ?? "n/a"}`);
          console.log(`total-tokens: ${total ?? "n/a"}`);
          if (input !== null && output !== null) {
            console.log(`total-tokens-expected: ${input + output}`);
            console.log(`context-length-expected: ${input + output}`);
          }

          console.log(`breakdown-available: ${breakdownAvailable}`);
          console.log(`breakdown-ok: ${ok}`);
          if (breakdownAvailable && !ok) {
            allOk = false;
            for (const err of errors) console.log(`breakdown-error: ${err}`);
          }

          if (input !== null && output !== null && contextLength === null) {
            allOk = false;
            console.log("breakdown-error: missing context_length");
          }

          if (runIndex > 1 && prev) {
            if (input !== null && prev.input !== null) {
              console.log(`delta-input-tokens: ${input - prev.input}`);
            }
            if (output !== null && prev.output !== null) {
              console.log(`delta-output-tokens: ${output - prev.output}`);
            }
            if (total !== null && prev.total !== null) {
              console.log(`delta-total-tokens: ${total - prev.total}`);
            }
            if (cacheRead !== null && prev.cacheRead !== null) {
              console.log(`delta-cache-read-tokens: ${cacheRead - prev.cacheRead}`);
            }
            if (cacheWrite !== null && prev.cacheWrite !== null) {
              console.log(`delta-cache-write-tokens: ${cacheWrite - prev.cacheWrite}`);
            }
            if (contextLength !== null && prev.contextLength !== null) {
              console.log(`delta-context-length: ${contextLength - prev.contextLength}`);
            }
          }

          prev = { input, output, total, cacheRead, cacheWrite, contextLength };
        }
      } finally {
        await session.dispose();
      }
    } else {
      for (let i = 0; i < options.runs; i++) {
        const runIndex = i + 1;
        const session = await runtime.openSession({});

        try {
          const turnPrompt = `${options.prompt}\n\n(turn ${runIndex}/${options.runs})`;

          const errorEvents: { message: string; code?: string }[] = [];
          const handle = await session.run({
            input: { parts: [{ type: "text", text: turnPrompt }] },
          });

          for await (const event of handle.events) {
            if (event.type === "error") {
              errorEvents.push({ message: event.message, code: event.code });
            }
          }

          const result = await handle.result;

          const usage = (result.usage ?? {}) as Record<string, unknown>;
          const { input, output, total, cacheRead, cacheWrite, contextLength } =
            readUsageNumbers(usage);
          const breakdownAvailable = hasAnyUsageNumbers(usage);
          const { ok, errors } = checkInvariants(usage);

          if ((cacheRead ?? 0) > 0 || (cacheWrite ?? 0) > 0) {
            sawAnyCacheTokens = true;
          }

          console.log(`run: ${runIndex}`);
          console.log(`status: ${result.status}`);
          if (result.status !== "success") {
            allOk = false;
            if (errorEvents.length > 0) {
              for (const err of errorEvents) {
                console.log(`run-error: ${err.code ? `${err.code}: ` : ""}${err.message}`);
              }
            }
          }
          console.log(`input-tokens: ${input ?? "n/a"}`);
          console.log(`output-tokens: ${output ?? "n/a"}`);
          console.log(`context-length: ${contextLength ?? "n/a"}`);
          console.log(`cache-read-tokens: ${cacheRead ?? "n/a"}`);
          console.log(`cache-write-tokens: ${cacheWrite ?? "n/a"}`);
          console.log(`total-tokens: ${total ?? "n/a"}`);
          if (input !== null && output !== null) {
            console.log(`total-tokens-expected: ${input + output}`);
            console.log(`context-length-expected: ${input + output}`);
          }

          console.log(`breakdown-available: ${breakdownAvailable}`);
          console.log(`breakdown-ok: ${ok}`);
          if (breakdownAvailable && !ok) {
            allOk = false;
            for (const err of errors) console.log(`breakdown-error: ${err}`);
          }

          if (input !== null && output !== null && contextLength === null) {
            allOk = false;
            console.log("breakdown-error: missing context_length");
          }
        } finally {
          await session.dispose();
        }
      }
    }
  } finally {
    await runtime.close();
  }

  return { allOk, sawAnyCacheTokens };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { dir, cleanup } = await createTempWorkspace(options.fillerWords, options.keepWorkspace);

  let ok = true;
  let sawCache = false;

  try {
    console.log(`workspace: ${dir}`);
    console.log(`filler-words: ${options.fillerWords}`);

    for (const provider of options.provider) {
      const model = provider === "claude" ? options.claudeModel : options.codexModel;
      const providerHomeOverride = provider === "claude" ? options.claudeHome : options.codexHome;
      const result = await runProvider({
        provider,
        sessionMode: options.sessionMode,
        runs: options.runs,
        workspaceDir: dir,
        prompt: options.prompt,
        model,
        providerHomeOverride,
      });

      if (!result.allOk) ok = false;
      if (result.sawAnyCacheTokens) sawCache = true;
    }
  } finally {
    await cleanup();
  }

  console.log(`any-cache-tokens: ${sawCache}`);
  console.log(`ok: ${ok}`);
  if (!ok) process.exit(1);
}

await main();
