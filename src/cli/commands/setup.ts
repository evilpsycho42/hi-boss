import { runConfigFileSetup } from "./setup/config-file.js";
import { runSetupExport } from "./setup/export.js";
import { runInteractiveSetup } from "./setup/interactive.js";

export interface SetupOptions {
  configFile?: string;
  token?: string;
  dryRun?: boolean;
}

export interface SetupExportOptions {
  outputPath?: string;
}

/**
 * Main setup entry point.
 */
export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const configFile = options.configFile?.trim();
  if (configFile) {
    await runConfigFileSetup({
      configFile,
      token: options.token,
      dryRun: Boolean(options.dryRun),
    });
    return;
  }

  await runInteractiveSetup();
}

export async function runSetupConfigExport(options: SetupExportOptions = {}): Promise<void> {
  await runSetupExport({ outputPath: options.outputPath });
}
