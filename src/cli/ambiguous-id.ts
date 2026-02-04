import { formatUnixMsAsLocalOffset } from "../shared/time.js";

type AmbiguousIdPrefixCandidate = Record<string, unknown> & {
  candidateId: string;
  candidateKind: string;
};

type AmbiguousIdPrefixErrorData = Record<string, unknown> & {
  kind: "ambiguous-id-prefix";
  idPrefix: string;
  matchCount: number;
  candidatesTruncated?: boolean;
  candidatesShown?: number;
  candidates: AmbiguousIdPrefixCandidate[];
};

function formatMaybeLocalOffset(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "(none)";
  return formatUnixMsAsLocalOffset(ms);
}

export function printAmbiguousIdPrefixError(data: AmbiguousIdPrefixErrorData): void {
  console.error("error: ambiguous-id-prefix");
  console.error(`id-prefix: ${data.idPrefix}`);
  console.error(`match-count: ${data.matchCount}`);

  if (data.candidatesTruncated === true) {
    console.error("candidates-truncated: true");
    if (typeof data.candidatesShown === "number" && Number.isFinite(data.candidatesShown)) {
      console.error(`candidates-shown: ${Math.trunc(data.candidatesShown)}`);
    }
  }

  for (let i = 0; i < data.candidates.length; i++) {
    const c = data.candidates[i]!;
    console.error(`candidate-id: ${String(c.candidateId)}`);
    console.error(`candidate-kind: ${String(c.candidateKind)}`);

    if (c.candidateKind === "memory") {
      if (typeof c.category === "string") {
        console.error(`candidate-category: ${c.category}`);
      }
      if (typeof c.createdAt === "number") {
        console.error(`candidate-created-at: ${formatUnixMsAsLocalOffset(c.createdAt)}`);
      }
      if (typeof c.textPreview === "string") {
        console.error(`candidate-text-json: ${JSON.stringify(c.textPreview)}`);
      }
    } else if (c.candidateKind === "cron") {
      if (typeof c.cron === "string") {
        console.error(`candidate-cron: ${c.cron}`);
      }
      if (typeof c.to === "string") {
        console.error(`candidate-to: ${c.to}`);
      }
      if (typeof c.enabled === "boolean") {
        console.error(`candidate-enabled: ${c.enabled ? "true" : "false"}`);
      }
      console.error(`candidate-next-deliver-at: ${formatMaybeLocalOffset(c.nextDeliverAt)}`);
    }

    if (i !== data.candidates.length - 1) {
      console.error("");
    }
  }

  console.error("hint: re-run with a longer --id");
}

export function tryPrintAmbiguousIdPrefixError(err: unknown): boolean {
  const e = err as Error & { data?: unknown };
  const data = e.data;
  if (!data || typeof data !== "object") return false;
  const d = data as Partial<AmbiguousIdPrefixErrorData>;
  if (d.kind !== "ambiguous-id-prefix") return false;
  if (typeof d.idPrefix !== "string") return false;
  if (typeof d.matchCount !== "number" || !Number.isFinite(d.matchCount)) return false;
  if (!Array.isArray(d.candidates)) return false;

  printAmbiguousIdPrefixError(d as AmbiguousIdPrefixErrorData);
  return true;
}
