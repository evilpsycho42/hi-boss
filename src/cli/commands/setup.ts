import { runInteractiveSetup } from "./setup/interactive.js";

export interface SetupOptions {
  // Reserved for future setup options.
}

/**
 * Main setup entry point.
 */
export async function runSetup(options: SetupOptions = {}): Promise<void> {
  void options;
  await runInteractiveSetup();
}
