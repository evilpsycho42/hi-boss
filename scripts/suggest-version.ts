import * as fs from "node:fs";

type VersionType = "preview" | "stable";

type ParsedVersion = {
  raw: string;
  base: string; // YYYY.M.D
  rev?: number; // -rev.N
  rc?: number; // -rc.N
};

function readTextIfExists(path: string): string | undefined {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function parseArgs(argv: string[]): { type?: VersionType; date?: string; json: boolean; help: boolean } {
  let type: VersionType | undefined;
  let date: string | undefined;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--type") {
      const v = argv[i + 1];
      i++;
      if (v === "preview" || v === "stable") type = v;
      continue;
    }
    if (a.startsWith("--type=")) {
      const v = a.slice("--type=".length);
      if (v === "preview" || v === "stable") type = v;
      continue;
    }
    if (a === "--date") {
      date = argv[i + 1];
      i++;
      continue;
    }
    if (a.startsWith("--date=")) {
      date = a.slice("--date=".length);
      continue;
    }
  }

  return { type, date, json, help };
}

function formatBaseFromLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}.${m}.${day}`;
}

function parseBaseFromDateFlag(dateFlag: string): string | undefined {
  const m = dateFlag.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return undefined;
  if (mo < 1 || mo > 12) return undefined;
  if (d < 1 || d > 31) return undefined;
  return `${y}.${mo}.${d}`;
}

function parseVersion(raw: string): ParsedVersion | undefined {
  const m = raw.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-rev\.(\d+))?(?:-rc\.(\d+))?$/);
  if (!m) return undefined;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return undefined;

  const base = `${y}.${mo}.${d}`;
  const rev = m[4] ? Number(m[4]) : undefined;
  const rc = m[5] ? Number(m[5]) : undefined;

  if (rev !== undefined && !Number.isFinite(rev)) return undefined;
  if (rc !== undefined && !Number.isFinite(rc)) return undefined;

  return { raw, base, rev, rc };
}

function extractVersionsFromChangelog(changelog: string): ParsedVersion[] {
  const out: ParsedVersion[] = [];
  const lines = changelog.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("## ")) continue;
    if (trimmed.startsWith("## [Unreleased]") || trimmed === "## Unreleased") continue;

    // Accept either:
    //   ## [2026.2.5-rev.1-rc.1] - 2026-02-05
    //   ## 2026.2.5-rev.1-rc.1 - 2026-02-05
    const m = trimmed.match(/^##\s+\[?(\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9A-Za-z.-]+)?)\]?\b/);
    if (!m) continue;

    const parsed = parseVersion(m[1]);
    if (parsed) out.push(parsed);
  }
  return out;
}

function max(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  return nums.reduce((a, b) => (a > b ? a : b), nums[0]);
}

function suggestPreview(base: string, versions: ParsedVersion[]): string {
  const forBase = versions.filter((v) => v.base === base);

  const stableBaseExists = forBase.some((v) => v.rev === undefined && v.rc === undefined);

  const revVersions = forBase.filter((v) => v.rev !== undefined);
  if (revVersions.length > 0) {
    const revNums = revVersions.map((v) => v.rev!).filter((n) => Number.isFinite(n));
    const maxRev = max(revNums) ?? 1;

    const forRev = forBase.filter((v) => v.rev === maxRev);
    const stableRevExists = forRev.some((v) => v.rc === undefined);
    if (!stableRevExists) {
      const rcNums = forRev.map((v) => v.rc).filter((n): n is number => n !== undefined);
      const nextRc = (max(rcNums) ?? 0) + 1;
      return `${base}-rev.${maxRev}-rc.${nextRc}`;
    }

    return `${base}-rev.${maxRev + 1}-rc.1`;
  }

  const rcNums = forBase.map((v) => v.rc).filter((n): n is number => n !== undefined);
  if (stableBaseExists) return `${base}-rev.1-rc.1`;
  if (rcNums.length > 0) return `${base}-rc.${(max(rcNums) ?? 0) + 1}`;
  return `${base}-rc.1`;
}

function suggestStable(base: string, versions: ParsedVersion[]): string {
  const forBase = versions.filter((v) => v.base === base);

  const revVersions = forBase.filter((v) => v.rev !== undefined);
  if (revVersions.length > 0) {
    const revNums = revVersions.map((v) => v.rev!).filter((n) => Number.isFinite(n));
    const maxRev = max(revNums) ?? 1;

    const forRev = forBase.filter((v) => v.rev === maxRev);
    const stableRevExists = forRev.some((v) => v.rc === undefined);
    const hasAnyRcForRev = forRev.some((v) => v.rc !== undefined);

    if (!stableRevExists && hasAnyRcForRev) return `${base}-rev.${maxRev}`;
    if (stableRevExists) return `${base}-rev.${maxRev + 1}`;
    return `${base}-rev.${maxRev}`;
  }

  const stableBaseExists = forBase.some((v) => v.rev === undefined && v.rc === undefined);
  const hasAnyRc = forBase.some((v) => v.rc !== undefined);

  if (!stableBaseExists && hasAnyRc) return `${base}`;
  if (stableBaseExists) return `${base}-rev.1`;
  return `${base}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.type) {
    const help = [
      "suggest-version: print a suggested npm version for today",
      "",
      "Usage:",
      "  npm run version:suggest -- --type preview",
      "  npm run version:suggest -- --type stable",
      "",
      "Options:",
      "  --type preview|stable   Required",
      "  --date YYYY-MM-DD       Override local date",
      "  --json                  JSON output",
    ].join("\n");
    console.log(help);
    process.exit(args.type ? 0 : 2);
  }

  const base =
    (args.date ? parseBaseFromDateFlag(args.date) : undefined) ?? formatBaseFromLocalDate(new Date());

  const changelogText = readTextIfExists("CHANGELOG.md") ?? "";
  const versions = extractVersionsFromChangelog(changelogText);

  const suggested = args.type === "preview" ? suggestPreview(base, versions) : suggestStable(base, versions);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          "suggested-version": suggested,
          "version-type": args.type,
          "base-date": base.replace(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/, "$1-$2-$3"),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(suggested);
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
}

