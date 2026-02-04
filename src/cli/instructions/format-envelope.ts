import type { Envelope } from "../../envelope/types.js";
import { renderPrompt } from "../../shared/prompt-renderer.js";
import { buildCliEnvelopePromptContext } from "../../shared/prompt-context.js";

export function formatEnvelopeInstruction(envelope: Envelope, bossTimezone: string): string {
  const context = buildCliEnvelopePromptContext({ envelope, bossTimezone });
  return renderPrompt({
    surface: "cli-envelope",
    template: "envelope/instruction.md",
    context,
  }).trimEnd();
}
