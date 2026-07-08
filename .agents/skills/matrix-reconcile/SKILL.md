---
name: matrix-reconcile
description: Reconcile test/TEST-MATRIX.md with the code changed since the last reconciliation — git-derived work-list (npm run matrix:delta), line-by-line read of the changed files, cases added/updated/deleted, status table recounted, fingerprint re-stamped. Use when the matrix guard (scripts/test-matrix.test.ts) is red, before committing behavior changes, or whenever asked to update the test matrix.
---

# Reconcile the test matrix from the git delta

The work-list is mechanical, the reconciliation is judgment. Never stamp without doing the work — the stamp is the declaration that the matrix truthfully inventories the current behavior.

1. **Get the work-list**: `npm run matrix:delta` — every behavior file added/modified since the stamped commit (committed and dirty). This list is exhaustive by construction; do not re-scan the whole repo.
2. **Read each listed file COMPLETELY** (with `git diff <stamped-commit> -- <file>` to focus on what changed, but read enough surrounding code to understand the behavior). For files deleted since the stamp, `git diff --name-status <stamped-commit>` shows them — their cases must be deleted.
3. **Reconcile `test/TEST-MATRIX.md`** per its own header rules:
   - New behavior → new cases at the next free id in the right area: `- [<area>.<n>] scenario | expected | kind | covered-today or GAP`.
   - Changed behavior → update the affected cases' scenario/expected/covered-today text.
   - Removed behavior → delete the case lines (ids retire, never reused).
   - A new test covering an existing case → flip its `GAP` to the covering `file ("test name")` reference.
   - Cross-cutting changes (process lifecycle, parallelism, journeys) may also need cases in the `cross-*` matrices.
4. **Recount the status table** for every touched area (cases = bullets, gaps = lines containing `GAP`, covered = cases − gaps, TOTAL = sums). The guard recounts independently — let it arbitrate: run step 6, fix any mismatch it reports.
5. **Stamp**: `npm run matrix:stamp`.
6. **Verify**: `npx vitest run scripts/test-matrix.test.ts` → must be 3/3 green.

For a large delta, fan the per-file case extraction out to subagents (one per file group), then merge their bullets yourself — the ids, table, and stamp stay a single-writer step.
