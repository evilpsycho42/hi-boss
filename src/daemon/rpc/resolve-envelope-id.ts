import type { HiBossDatabase } from "../db/database.js";
import { RPC_ERRORS } from "../ipc/types.js";
import { rpcError } from "./context.js";
import {
  DEFAULT_ID_PREFIX_LEN,
  DEFAULT_CANDIDATE_TEXT_MAX_LEN,
  compactUuid,
  computeUniqueCompactPrefixLength,
  isHexLower,
  normalizeIdPrefixInput,
  truncateForCli,
} from "../../shared/id-format.js";

const MAX_AMBIGUOUS_ID_CANDIDATES = 20;

function assertValidIdPrefix(prefix: string): void {
  if (prefix.length < DEFAULT_ID_PREFIX_LEN) {
    rpcError(
      RPC_ERRORS.INVALID_PARAMS,
      `Invalid id (expected at least ${DEFAULT_ID_PREFIX_LEN} hex chars)`
    );
  }
  if (!isHexLower(prefix)) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid id (expected hex UUID prefix)");
  }
}

function buildAmbiguousEnvelopeIdPrefixData(params: {
  idPrefix: string;
  envelopes: Array<{ id: string; from: string; to: string; createdAt: number; text: string }>;
}): Record<string, unknown> {
  const compactIds = params.envelopes.map((e) => compactUuid(e.id));
  const prefixLen = computeUniqueCompactPrefixLength(
    compactIds,
    Math.max(DEFAULT_ID_PREFIX_LEN, params.idPrefix.length)
  );

  const truncated = params.envelopes.length > MAX_AMBIGUOUS_ID_CANDIDATES;
  const shown = params.envelopes.slice(0, MAX_AMBIGUOUS_ID_CANDIDATES).map((e) => ({
    candidateId: compactUuid(e.id).slice(0, prefixLen),
    candidateKind: "envelope",
    from: e.from,
    to: e.to,
    createdAt: e.createdAt,
    textPreview: truncateForCli(e.text ?? "", DEFAULT_CANDIDATE_TEXT_MAX_LEN),
  }));

  return {
    kind: "ambiguous-id-prefix",
    idPrefix: params.idPrefix,
    matchCount: params.envelopes.length,
    candidatesTruncated: truncated,
    candidatesShown: shown.length,
    candidates: shown,
  };
}

/**
 * Resolve a user/agent-facing envelope id input (short id, longer prefix, or full UUID)
 * into a full envelope UUID.
 */
export function resolveEnvelopeIdInput(db: HiBossDatabase, rawId: string): string {
  const trimmed = rawId.trim();
  if (!trimmed) {
    rpcError(RPC_ERRORS.INVALID_PARAMS, "Invalid envelope-id");
  }

  const direct = db.getEnvelopeById(trimmed);
  if (direct) return direct.id;

  const idPrefix = normalizeIdPrefixInput(trimmed);
  assertValidIdPrefix(idPrefix);

  const matches = db.findEnvelopesByIdPrefix(idPrefix);
  if (matches.length === 0) {
    rpcError(RPC_ERRORS.NOT_FOUND, "Envelope not found");
  }
  if (matches.length > 1) {
    rpcError(
      RPC_ERRORS.INVALID_PARAMS,
      "Ambiguous id prefix",
      buildAmbiguousEnvelopeIdPrefixData({
        idPrefix,
        envelopes: matches.map((e) => ({
          id: e.id,
          from: e.from,
          to: e.to,
          createdAt: e.createdAt,
          text: e.content.text ?? "",
        })),
      })
    );
  }

  return matches[0].id;
}
