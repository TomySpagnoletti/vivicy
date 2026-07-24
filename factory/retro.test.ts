import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";

import { RETRO_REPORT_REL, RETRO_VERDICT_REL, RetroConfigError, runRetro } from "./retro.ts";
import type { SpawnRetroLeg } from "./retro.ts";

function makeRepo({ total = 2, done = total, baseline = true }: { total?: number; done?: number; baseline?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "vivicy-retro-"));
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const id = (i: number): string => `ISS-${String(i + 1).padStart(4, "0")}`;
  write(".vivicy/development/issue-index.json", JSON.stringify({ issues: Array.from({ length: total }, (_, i) => ({ id: id(i) })) }));
  for (let i = 0; i < done; i += 1) write(`.vivicy/development/issues/done/${id(i)}.md`, `# ${id(i)}\n`);
  if (baseline) {
    write(".vivicy/baselines/baseline-v1.0.0.json", JSON.stringify({ schema_version: 1, baseline_id: "baseline-v1.0.0", version: "1.0.0", status: "frozen", files: [] }));
  }
  return root;
}

function verdictLeg(verdict: unknown, spy?: { calls: number }): SpawnRetroLeg {
  return async ({ repoRoot, verdictRel }) => {
    if (spy) spy.calls += 1;
    const abs = join(repoRoot, verdictRel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(verdict));
  };
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

test("runRetro requires a repoRoot (typed config error)", async () => {
  await assert.rejects(() => runRetro({}), (e) => e instanceof RetroConfigError);
});

test("a clean cycle (no recurring classes) is a quiet retro — no proposals, nothing to decide", async () => {
  const root = makeRepo({ total: 2 });
  try {
    const report = await runRetro({ repoRoot: root, spawnLeg: verdictLeg({ recurring_classes: [], proposals: [] }) });
    assert.equal(report.phase, "quiet");
    assert.deepEqual(report.proposals, []);
    assert.deepEqual(report.recurring_classes, []);
    assert.equal(report.baseline_id, "baseline-v1.0.0");
    assert.match(report.summary ?? "", /clean cycle/i);
    const onDisk = JSON.parse(readFileSync(join(root, RETRO_REPORT_REL), "utf8"));
    assert.equal(onDisk.phase, "quiet");
  } finally {
    cleanup(root);
  }
});

test("recurring classes with mapped proposals flip the report to 'proposals' and record them as owner-decided data", async () => {
  const root = makeRepo({ total: 2 });
  try {
    const report = await runRetro({
      repoRoot: root,
      spawnLeg: verdictLeg({
        recurring_classes: [
          { id: "gate-flake-typecheck", kind: "gate_flake", signature: "typecheck gate flaked transiently, green on retry", occurrences: 3, evidence: [".vivicy/development/gates/ISS-0001-gate.json", ".vivicy/development/gates/ISS-0002-gate.json", ".vivicy/development/gates/ISS-0003-gate.json"] },
          { id: "blocked-quota", kind: "blocked_cause", signature: "issue blocked on quota exhaustion", occurrences: 2, evidence: [".vivicy/development/reports/ISS-0004-blocked.json", ".vivicy/development/reports/ISS-0005-blocked.json"] },
        ],
        proposals: [
          { landing: "method_block", title: "Prime the type cache before the gate", rationale: "3 transient typecheck flakes", detail: "Add a method-block bullet: prime the type cache before the first gate.", addresses: ["gate-flake-typecheck"] },
          { landing: "settings", title: "Lower concurrency to reduce quota bursts", detail: "Set maxParallel to 2.", addresses: ["blocked-quota"] },
        ],
      }),
    });
    assert.equal(report.phase, "proposals");
    assert.equal(report.recurring_classes?.length, 2);
    assert.equal(report.recurring_classes?.[0]?.occurrences, 3, "occurrences is derived from the distinct evidence count, not the leg's asserted integer");
    assert.equal(report.recurring_classes?.[1]?.occurrences, 2);
    assert.equal(report.proposals?.length, 2);
    assert.equal(report.proposals?.[0]?.landing, "method_block");
    assert.equal(report.proposals?.[1]?.landing, "settings");
    assert.match(report.summary ?? "", /owner-decided|until you click/i);
  } finally {
    cleanup(root);
  }
});

test("the recurring-class floor is orchestrator-enforced on the EVIDENCE, not the leg's asserted integer: only classes with ≥2 distinct witnesses survive (P1/P5)", async () => {
  const root = makeRepo({ total: 2 });
  try {
    const report = await runRetro({
      repoRoot: root,
      spawnLeg: verdictLeg({
        recurring_classes: [
          { id: "empty-evidence", kind: "gate_flake", signature: "claims two but cites nothing", occurrences: 2, evidence: [] },
          { id: "fake-count", kind: "blocked_cause", signature: "claims five, cites one", occurrences: 5, evidence: [".vivicy/development/reports/ISS-0001-blocked.json"] },
          { id: "no-evidence-field", kind: "quota", signature: "claims five, no evidence field at all", occurrences: 5 },
          { id: "dup-refs", kind: "review_finding", signature: "same witness cited twice is one witness", occurrences: 2, evidence: [".vivicy/development/gates/ISS-0001-gate.json", ".vivicy/development/gates/ISS-0001-gate.json"] },
          { id: "real", kind: "blocked_cause", signature: "two distinct witnesses", occurrences: 5, evidence: [".vivicy/development/reports/ISS-0001-blocked.json", ".vivicy/development/reports/ISS-0002-blocked.json"] },
        ],
        proposals: [{ landing: "skill", title: "Install a linter skill", detail: "acme/lint@lint", addresses: ["real"] }],
      }),
    });
    assert.equal(report.recurring_classes?.length, 1, "only the class witnessed by ≥2 DISTINCT evidence files survives; leg-asserted occurrences are never trusted");
    assert.equal(report.recurring_classes?.[0]?.id, "real");
    assert.equal(report.recurring_classes?.[0]?.occurrences, 2, "occurrences is overwritten with the distinct-witness count (2), not the leg's claimed 5");
    assert.deepEqual(report.recurring_classes?.[0]?.evidence, [".vivicy/development/reports/ISS-0001-blocked.json", ".vivicy/development/reports/ISS-0002-blocked.json"]);
  } finally {
    cleanup(root);
  }
});

test("an invalid/absent proposal landing is coerced to canonical_clarification (the CR-flow catch-all)", async () => {
  const root = makeRepo({ total: 1 });
  try {
    const report = await runRetro({
      repoRoot: root,
      spawnLeg: verdictLeg({ recurring_classes: [], proposals: [{ landing: "totally-bogus", title: "Clarify the seam", detail: "State the tax rule once." }] }),
    });
    assert.equal(report.phase, "proposals");
    assert.equal(report.proposals?.[0]?.landing, "canonical_clarification");
  } finally {
    cleanup(root);
  }
});

test("a proposal missing a title or detail is dropped as non-actionable", async () => {
  const root = makeRepo({ total: 1 });
  try {
    const report = await runRetro({
      repoRoot: root,
      spawnLeg: verdictLeg({
        recurring_classes: [{ id: "c", kind: "review_finding", signature: "same finding twice", evidence: [".vivicy/development/transcripts/ISS-0001/x.jsonl", ".vivicy/development/transcripts/ISS-0002/x.jsonl"] }],
        proposals: [
          { landing: "method_block", title: "", detail: "no title" },
          { landing: "method_block", title: "no detail", detail: "" },
          { landing: "settings", title: "keep this", detail: "set effort to high" },
        ],
      }),
    });
    assert.equal(report.proposals?.length, 1);
    assert.equal(report.proposals?.[0]?.title, "keep this");
  } finally {
    cleanup(root);
  }
});

test("zero automatic rule mutation: runRetro writes ONLY the report and the verdict — no CR, no AGENTS.md, no settings", async () => {
  const root = makeRepo({ total: 2 });
  const before = new Set(listFiles(root));
  try {
    await runRetro({
      repoRoot: root,
      spawnLeg: verdictLeg({
        recurring_classes: [{ id: "c", kind: "blocked_cause", signature: "same block twice", evidence: [".vivicy/development/reports/ISS-0001-blocked.json", ".vivicy/development/reports/ISS-0002-blocked.json"] }],
        proposals: [
          { landing: "method_block", title: "Amend the block", detail: "Add a bullet." },
          { landing: "canonical_clarification", title: "Clarify a doc", detail: "State it once." },
        ],
      }),
    });
    const added = listFiles(root).filter((f) => !before.has(f)).sort();
    assert.deepEqual(added, [RETRO_REPORT_REL, RETRO_VERDICT_REL].sort(), "retro mutates no rule — only its report and the leg's verdict appear");
    assert.equal(existsSync(join(root, ".vivicy/change-requests")), false, "retro drafts no change request automatically");
  } finally {
    cleanup(root);
  }
});

test("retro never blocks the close: a config failure (done<total) is a loud 'failed' report, never a throw, and the leg never runs", async () => {
  const root = makeRepo({ total: 3, done: 2 });
  const spy = { calls: 0 };
  try {
    const report = await runRetro({ repoRoot: root, spawnLeg: verdictLeg({ recurring_classes: [], proposals: [] }, spy) });
    assert.equal(report.phase, "failed");
    assert.equal(spy.calls, 0, "the leg never runs before the cycle has closed");
    assert.match(report.summary ?? "", /close is not affected/i);
  } finally {
    cleanup(root);
  }
});

test("retro never blocks the close: no frozen baseline is a loud 'failed', never a throw", async () => {
  const root = makeRepo({ total: 2, baseline: false });
  try {
    const report = await runRetro({ repoRoot: root, spawnLeg: verdictLeg({ recurring_classes: [], proposals: [] }) });
    assert.equal(report.phase, "failed");
    assert.match(report.summary ?? "", /frozen baseline/i);
    assert.match(report.summary ?? "", /close is not affected/i);
  } finally {
    cleanup(root);
  }
});

test("retro never blocks the close: a timed-out leg is a loud 'failed', the run returns normally", async () => {
  const root = makeRepo({ total: 2 });
  try {
    const timeoutLeg: SpawnRetroLeg = async () => ({ result: { timedOut: true, timeoutReason: "no output for 12m" } });
    const report = await runRetro({ repoRoot: root, spawnLeg: timeoutLeg });
    assert.equal(report.phase, "failed");
    assert.match(report.summary ?? "", /timed out/);
    assert.match(report.summary ?? "", /close is not affected/i);
  } finally {
    cleanup(root);
  }
});

test("retro never blocks the close: a missing/malformed verdict is a loud 'failed', the run returns normally", async () => {
  const root = makeRepo({ total: 2 });
  try {
    const noWrite: SpawnRetroLeg = async () => undefined;
    const report = await runRetro({ repoRoot: root, spawnLeg: noWrite });
    assert.equal(report.phase, "failed");
    assert.match(report.summary ?? "", /no valid verdict/);
    assert.match(report.summary ?? "", /close is not affected/i);
  } finally {
    cleanup(root);
  }
});

test("a leg error is caught into a loud 'failed', never propagated (observability, never fatal)", async () => {
  const root = makeRepo({ total: 2 });
  try {
    const throwingLeg: SpawnRetroLeg = async () => {
      throw new Error("leg crashed");
    };
    const report = await runRetro({ repoRoot: root, spawnLeg: throwingLeg });
    assert.equal(report.phase, "failed");
    assert.match(report.summary ?? "", /leg crashed/);
  } finally {
    cleanup(root);
  }
});

test("a settled retro is not re-run unless forced (idempotent, no duplicate leg spawn)", async () => {
  const root = makeRepo({ total: 2 });
  const spy = { calls: 0 };
  try {
    const first = await runRetro({ repoRoot: root, spawnLeg: verdictLeg({ recurring_classes: [], proposals: [] }, spy) });
    assert.equal(first.phase, "quiet");
    assert.equal(spy.calls, 1);
    const second = await runRetro({ repoRoot: root, spawnLeg: verdictLeg({ recurring_classes: [], proposals: [] }, spy) });
    assert.equal(second.phase, "quiet");
    assert.equal(spy.calls, 1, "settled quiet is not re-run");
    const forced = await runRetro({ repoRoot: root, spawnLeg: verdictLeg({ recurring_classes: [], proposals: [] }, spy), force: true });
    assert.equal(forced.phase, "quiet");
    assert.equal(spy.calls, 2, "force re-runs the leg (the retry-dev path)");
  } finally {
    cleanup(root);
  }
});

test("the leg writes its verdict to the reserved report path, not the committed report", async () => {
  const root = makeRepo({ total: 1 });
  try {
    await runRetro({ repoRoot: root, spawnLeg: verdictLeg({ recurring_classes: [], proposals: [] }) });
    assert.notEqual(RETRO_VERDICT_REL, RETRO_REPORT_REL, "the leg's proposal and the orchestrator's recorded report are distinct files");
  } finally {
    cleanup(root);
  }
});
