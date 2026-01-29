import type { Envelope } from "../../envelope/types.js";
import { renderPrompt } from "../../shared/prompt-renderer.js";
import { buildCliEnvelopePromptContext } from "../../shared/prompt-context.js";

export function formatEnvelopeInstruction(envelope: Envelope): string {
  const context = buildCliEnvelopePromptContext({ envelope });
  return renderPrompt({
    surface: "cli-envelope",
    template: "envelope/instruction.md",
    context,
  }).trimEnd();
}

