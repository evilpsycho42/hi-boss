import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { HIBOSS_TOKEN_ENV } from "../../shared/env.js";

const MEM_CLI_TOKEN_ENV = "MEM_CLI_TOKEN";

export function runMem(options: { args: string[] }): void {
  const require = createRequire(import.meta.url);

  let entry: string;
  try {
    entry = require.resolve("@kky42/mem-cli/dist/index.js");
  } catch {
    console.error("error: mem-cli is not installed (missing @kky42/mem-cli dependency)");
    process.exitCode = 1;
    return;
  }

  const forwardedArgs = buildForwardedArgs(options.args);

  // Prefer passing the Hi-Boss token via env (so it doesn't appear in argv).
  const env = { ...process.env };
  const hibossToken = env[HIBOSS_TOKEN_ENV]?.trim();
  if (hibossToken) {
    env[MEM_CLI_TOKEN_ENV] = hibossToken;
  }

  const res = spawnSync(process.execPath, [entry, ...forwardedArgs], {
    stdio: "inherit",
    env,
  });

  if (res.error) {
    console.error("error:", res.error.message);
    process.exitCode = 1;
    return;
  }

  process.exitCode = res.status ?? 1;
}

function buildForwardedArgs(rawArgs: string[]): string[] {
  if (rawArgs.length === 0) return ["--help"];
  return rawArgs;
}
