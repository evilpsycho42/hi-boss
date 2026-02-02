/**
 * Turn input builder for agent runs.
 *
 * Builds the input text for a single agent turn, combining context and pending envelopes.
 */

import type { Envelope } from "../envelope/types.js";
import { renderPrompt } from "../shared/prompt-renderer.js";
import { buildTurnPromptContext } from "../shared/prompt-context.js";

/**
 * Context for the current turn.
 */
export interface TurnContext {
  datetime: string;  // ISO 8601 (UTC recommended; rendered as local time)
  agentName: string;
}

/**
 * Input for building turn text.
 */
export interface TurnInput {
  context: TurnContext;
  envelopes: Envelope[];  // oldest N pending envelopes
}

/**
 * Build the full turn input text.
 *
 * Output format:
 * ```
 * ## Turn Context
 *
 * now: 2026-01-27T20:00:00+08:00
 *
 * ---
 * ## Pending Envelopes (3)
 *
 * ### Envelope 1
 *
 * from: channel:telegram:12345
 * from-name: group "hiboss-test"
 *
 * Alice (@alice) at 2026-01-27T20:00:00+08:00:
 * Hello!
 *
 * Bob (@bob) at 2026-01-27T20:01:00+08:00:
 * Hi!
 *
 * ---
 *
 * ### Envelope 2
 * ...
 * ```
 *
 * Note: consecutive group-chat envelopes from the same `from:` address are batched under a single
 * `### Envelope <index>` header for token efficiency (header printed once, multiple message lines).
 *
 * @param turnInput - Turn context and envelopes
 * @returns Formatted turn input text
 */
export function buildTurnInput(turnInput: TurnInput): string {
  const { context, envelopes } = turnInput;

  const promptContext = buildTurnPromptContext({
    agentName: context.agentName,
    datetimeIso: context.datetime,
    envelopes,
  });

  return renderPrompt({
    surface: "turn",
    template: "turn/turn.md",
    context: promptContext,
  }).trimEnd();
}

/**
 * Format a single envelope as a prompt (for single-envelope runs).
 *
 * @param envelope - The envelope to format
 * @returns Formatted envelope text
 */
export function formatEnvelopeAsPrompt(envelope: Envelope): string {
  return buildTurnInput({
    context: { datetime: new Date().toISOString(), agentName: "(single-envelope)" },
    envelopes: [envelope],
  });
}
