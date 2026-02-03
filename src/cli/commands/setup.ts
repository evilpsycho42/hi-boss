import { runConfigFileSetup } from "./setup/config-file.js";
import { runInteractiveSetup } from "./setup/interactive.js";

export interface SetupOptions {
  configFile?: string;
}

/**
 * Main setup entry point.
 */
export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const configFile = options.configFile?.trim();
  if (configFile) {
    await runConfigFileSetup({ configFile });
    return;
  }

  await runInteractiveSetup();
}
