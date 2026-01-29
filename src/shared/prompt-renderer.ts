import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import nunjucks from "nunjucks";

export type PromptSurface = "system" | "turn" | "cli-envelope";

export interface RenderOptions {
  surface: PromptSurface;
  /**
   * Template path relative to `prompts/`, including extension.
   * Example: `system/base.md`
   */
  template: string;
  /**
   * Template context object.
   *
   * Avoid exposing functions or live resources (fs, db, clients). Keep this data-only.
   */
  context: Record<string, unknown>;
}

type PromptEnvironment = {
  promptsDir: string;
  env: nunjucks.Environment;
};

let cachedEnv: PromptEnvironment | null = null;

function findUp(startDir: string, predicate: (dir: string) => boolean): string | null {
  let current = startDir;
  while (true) {
    if (predicate(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolvePromptsDir(startDir?: string): string {
  const resolvedStart =
    startDir ?? path.dirname(fileURLToPath(import.meta.url));

  const repoRoot = findUp(resolvedStart, (dir) =>
    fs.existsSync(path.join(dir, "package.json"))
  );
  if (!repoRoot) {
    throw new Error(
      `Unable to locate project root (package.json) to resolve prompts (start-dir: ${resolvedStart})`
    );
  }

  return path.join(repoRoot, "prompts");
}

function getEnvironment(): PromptEnvironment {
  if (cachedEnv) return cachedEnv;

  const promptsDir = resolvePromptsDir();
  const loader = new nunjucks.FileSystemLoader(promptsDir, {
    // Make prompt edits take effect immediately without restarts.
    noCache: true,
  });

  const env = new nunjucks.Environment(loader, {
    autoescape: false,
    throwOnUndefined: true,
    trimBlocks: true,
    lstripBlocks: true,
  });

  cachedEnv = { promptsDir, env };
  return cachedEnv;
}

export function clearPromptCache(): void {
  cachedEnv = null;
}

export function renderPrompt(options: RenderOptions): string {
  const { env, promptsDir } = getEnvironment();
  const template = options.template.replace(/\\/g, "/");

  try {
    return env.render(template, options.context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[PromptRenderer] Failed to render ${options.surface} template "${template}" (prompts-dir: ${promptsDir}): ${message}`,
      { cause: error }
    );
  }
}

