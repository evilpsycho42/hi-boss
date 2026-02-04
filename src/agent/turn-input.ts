/**
 * Turn input builder for agent runs.
 *
 * Builds the input text for a single agent turn, combining context and pending envelopes.
 */

import type { Envelope } from "../envelope/types.js";
import { renderPrompt } from "../shared/prompt-renderer.js";
import { buildTurnPromptContext } from "../shared/prompt-context.js";
import { getDaemonIanaTimeZone } from "../shared/timezone.js";

/**
 * Context for the current turn.
 */
export interface TurnContext {
  datetimeMs: number; // unix epoch ms (UTC)
  agentName: string;
  bossTimezone: string; // IANA timezone used for displayed timestamps
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
 * pending-envelopes: 3
 *
 * ---
 *
 * from: channel:telegram:12345
 * sender: Alice (@alice) in group "hiboss-test"
 * channel-message-id: zik0zj
 * created-at: 2026-01-27T20:00:00+08:00
 *
 * Hello!
 *
 * ---
 *
 * from: channel:telegram:12345
 * sender: Bob (@bob) in group "hiboss-test"
 * channel-message-id: zik0zk
 * created-at: 2026-01-27T20:01:00+08:00
 *
 * Hi!
 *
 * ---
 * ...
 * ```
 *
 * @param turnInput - Turn context and envelopes
 * @returns Formatted turn input text
 */
export function buildTurnInput(turnInput: TurnInput): string {
  const { context, envelopes } = turnInput;

  const promptContext = buildTurnPromptContext({
    agentName: context.agentName,
    datetimeMs: context.datetimeMs,
    bossTimezone: context.bossTimezone,
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
    context: { datetimeMs: Date.now(), agentName: "(single-envelope)", bossTimezone: getDaemonIanaTimeZone() },
    envelopes: [envelope],
  });
}
