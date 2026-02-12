# Strict TypeScript Adoption Plan — Multi-Repo Platform

**Status:** Draft
**Date:** 2026-02-12
**Audience:** Engineering leads, platform team, repo owners

---

## Ownership Model

- **Migration champion per repo:** A named engineer in each repo responsible for driving that repo's migration, resolving type errors, and reviewing strict-mode PRs. Champions are accountable for their repo's timeline but not expected to do all the work alone.
- **Platform team** owns the shared `tsconfig.base.json`, CI gate configuration, ESLint rule definitions, and the type-coverage reporting toolchain. They provide the infrastructure; repo teams provide the effort.
- **Weekly sync:** 30-minute standing meeting for all champions + platform team. Agenda: blockers, timeline adjustments, cross-repo dependency issues. Async updates via a shared channel between syncs.
- **Escalation path:** Champion → platform team → engineering leadership. Blockers unresolved for more than one week escalate automatically.

---

## Phase 0 — Foundation (Week 1–2)

**Goal:** Establish the shared configuration, tooling, and process so that all subsequent migration work builds on a single, consistent base.

**Actions:**

1. Create a `tsconfig.base.json` with `strict: true` and publish it as an internal package (or place it in the mono-repo root). All repos will extend this base config.
2. Each repo begins in compatibility mode: extends the base config but may temporarily override specific strict flags (e.g., `strictNullChecks: false`) via an allow-list that is tracked and must shrink over time.
3. Add a CI gate running `tsc --noEmit` on every PR. Initially this gate is non-blocking (warning only) for repos that haven't started migration. It becomes blocking per-repo as each repo enters its active migration phase.
4. Add an ESLint rule banning `any` (`@typescript-eslint/no-explicit-any` set to error). During Phase 0 this runs in warning mode; it flips to error per-package as that package is migrated.
5. Set up automated type-coverage reporting (e.g., `type-coverage` npm package) that posts a coverage percentage as a PR comment. Establish the baseline coverage number for every repo.
6. Assign a migration champion for each repo. Document the champion roster in the project tracker.

**Milestone:** Shared `tsconfig.base.json` published, CI gates deployed (warning mode) across all repos, baseline type-coverage numbers recorded, champions assigned.

**Verification:** Every repo's CI pipeline runs `tsc --noEmit` and the ESLint `no-explicit-any` rule without pipeline failures (warnings are expected at this stage).

---

## Phase 1 — Core Libraries (Week 3–5)

**Goal:** Migrate all shared and internal packages first, since every downstream service depends on them. Clean foundations prevent cascading type issues later.

**Actions:**

1. Inventory all shared packages and rank them by dependency depth (leaf packages first, then packages that depend on other shared packages).
2. For each shared package, in dependency order:
   - Remove strict-flag overrides from its `tsconfig.json` so it inherits full `strict: true`.
   - Fix all resulting type errors. Prefer narrowing types, adding type guards, and using `unknown` over suppression comments.
   - Flip the ESLint `no-explicit-any` rule to error for that package.
   - Open a PR, get review from the champion + one platform team member, merge when CI is green.
3. Where a shared package re-exports types from a third-party lib that lacks type definitions, write a focused `.d.ts` declaration file or contribute types to DefinitelyTyped. Track these in a "type-gap" registry so they aren't forgotten.
4. Update the shared package's type-coverage threshold to its new post-migration level so that regressions are caught automatically.

**Milestone:** All shared/internal packages pass `tsc --noEmit` under full `strict: true` with zero `any` usage.

**Verification:** CI is green (blocking mode) for all shared packages. Type-coverage for shared packages is at or above the new threshold. No `any` in shared package source files (ESLint error, not warning).

---

## Phase 2 — Service-by-Service Rollout (Week 6–12)

**Goal:** Migrate each service to strict mode, working in dependency order so that a service's dependencies are already strict by the time it starts.

**Actions:**

1. Order services by their dependency graph (leaf services with fewest internal dependencies first, gateway/orchestration services last).
2. Each service's champion:
   - Removes strict-flag overrides from the service's `tsconfig.json`.
   - Fixes type errors in batches (recommend no more than 200–300 errors per PR to keep reviews manageable).
   - Flips `no-explicit-any` to error for the service.
   - Submits PRs for review. Each PR must have CI green before merge.
3. Platform team flips the service's CI gate from warning to blocking once the champion confirms the service is ready.
4. Two-week verification checkpoints (end of Week 8, Week 10, Week 12):
   - All services scheduled for that checkpoint window must have their migration PRs merged and CI green.
   - Type-coverage report reviewed in the weekly sync. Any service below its threshold is flagged.
   - Champions for late services present a revised timeline at the sync.
5. Services that share a database schema or API contract should coordinate their migration windows to avoid interface mismatches during the transition.

**Milestone:** Every service's strict-mode PR is merged and CI is blocking. No service has `any` overrides in its `tsconfig.json`.

**Verification (at each 2-week checkpoint):**
- CI green across all migrated services.
- Type-coverage at or above the per-service threshold.
- No new `any` introductions (enforced by ESLint in error mode).
- Automated PR comment reports show no regressions.

---

## Phase 3 — Tests & Tooling (Week 10–14)

**Goal:** Extend strict mode to test files, build scripts, CI scripts, and any remaining TypeScript outside of production source. This phase overlaps with the tail end of Phase 2 intentionally — services finishing early can begin here.

**Actions:**

1. Include test directories (`**/*.test.ts`, `**/*.spec.ts`) in the strict compilation. Many test files use loose typing or `any` for mocks; these need explicit types or typed mock utilities.
2. Migrate build scripts, code generators, and CI helper scripts to strict TypeScript. Where scripts are trivial shell wrappers, consider whether they should remain as bash rather than poorly-typed TypeScript.
3. Update mock and fixture factories to return properly typed objects instead of `as any` casts. Introduce shared test utilities where patterns repeat across repos.
4. Add test-file type-coverage to the automated PR report so that test regressions are visible.

**Milestone:** 100% of TypeScript files across all repos (source, test, scripts, tooling) compile under `strict: true`. No file is excluded from the strict tsconfig.

**Verification:** CI runs `tsc --noEmit` over the full file set (including tests and scripts) and passes. Type-coverage for the entire repo (not just `src/`) meets the threshold. ESLint `no-explicit-any` is error-level everywhere.

---

## Phase 4 — Hardening & Maintenance (Ongoing)

**Goal:** Lock down the configuration so strict mode cannot regress, and establish ongoing practices that maintain type safety as the codebase evolves.

**Actions:**

1. Remove all temporary strict-flag overrides from every repo's `tsconfig.json`. The only `tsconfig.json` settings should be path/output config and the `extends` pointing to the shared base.
2. Disallow `skipLibCheck: true` in any repo config. If a third-party lib causes issues, fix the types or pin the version — do not suppress checking.
3. Add a CI check that fails if any `tsconfig.json` in the repo tree contains override flags from an explicit deny-list (`strict: false`, `noImplicitAny: false`, `skipLibCheck: true`, etc.).
4. Establish a type-coverage floor (e.g., 95%) enforced in CI. The floor only goes up, never down.
5. Quarterly audit (run by the platform team):
   - Scan for `@ts-ignore`, `@ts-expect-error`, and `as any` across all repos. Each instance must have a linked issue or a justification comment.
   - Review the type-gap registry for third-party libs. Remove entries where types have been published upstream.
   - Update the shared `tsconfig.base.json` to adopt any new strict-related compiler flags introduced in recent TypeScript releases.
6. Onboarding: add a "strict TypeScript" section to the developer onboarding guide explaining conventions, common patterns (type guards, `unknown` vs `any`, discriminated unions), and how to read type-coverage reports.

**Milestone:** No repo can merge a PR that weakens type strictness. Type-coverage is tracked, visible, and trending upward.

**Verification:** Quarterly audit report shared with engineering leadership. CI enforces the deny-list and the coverage floor. Zero open type-gap registry items older than one quarter.

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| **Velocity hit during migration sprints** | Teams spend more time on type fixes than feature work, slowing delivery. | High during Phases 1–3. | Scope migration PRs to 200–300 errors max. Allow champions to timebox migration work to 30% of sprint capacity. Adjust service migration order to avoid blocking critical feature work. Accept that some velocity loss is the cost of the investment. |
| **Third-party libraries without type definitions** | Blocks strict compilation or forces unsafe `any` casts. | Medium. Common in niche or internal-fork dependencies. | Maintain a type-gap registry from Phase 1. Write focused `.d.ts` files for critical untyped deps. Contribute to DefinitelyTyped where feasible. For low-priority deps, isolate them behind a typed wrapper module so the `any` is contained to one file. |
| **Team skill gaps** | Engineers unfamiliar with advanced TypeScript (generics, conditional types, type guards) produce low-quality fixes or avoid strict patterns. | Medium. Varies by team. | Run a 1-hour workshop before Phase 1 covering the most common strict-mode patterns. Pair junior engineers with champions for review. Maintain a shared "recipes" doc of before/after examples for common migration patterns. |
| **Divergent tsconfig across repos** | Repos drift from the shared base config, creating inconsistent behavior and false confidence in type safety. | Medium. Increases over time without enforcement. | The shared `tsconfig.base.json` is the single source of truth. Phase 4 CI checks enforce a deny-list of overrides. Any repo-specific config must be approved by the platform team. |
| **Merge conflicts from parallel migration PRs** | Multiple engineers fixing types in the same files create painful merge conflicts. | High during Phase 2 if services share code. | Coordinate migration windows in the weekly sync. Migrate shared code first (Phase 1) to reduce the surface area of conflicts in Phase 2. Keep migration PRs small and short-lived — open, review, merge within 1–2 days. |

---

## Verification Checkpoint Summary

| Checkpoint | Timing | Criteria |
|---|---|---|
| Phase 0 complete | End of Week 2 | CI gates deployed, baseline coverage recorded, champions assigned. |
| Phase 1 complete | End of Week 5 | All shared packages strict, zero `any`, CI blocking. |
| Phase 2 — first check | End of Week 8 | At least 50% of services migrated, CI green, coverage on track. |
| Phase 2 — second check | End of Week 10 | At least 80% of services migrated. Late services have revised plans. |
| Phase 2 complete | End of Week 12 | All services strict, CI blocking everywhere. |
| Phase 3 complete | End of Week 14 | 100% TypeScript strict across all file types. |
| Phase 4 — ongoing | Quarterly | Audit report clean, coverage floor enforced, no stale type-gap items. |

At every checkpoint, the platform team publishes a one-page status summary: repos migrated, current type-coverage numbers, open blockers, and any timeline adjustments. This goes to engineering leadership and is reviewed in the weekly sync.
