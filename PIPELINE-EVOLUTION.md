# Pipeline Evolution — v0.5.0

Sources: the owner's Excalidraw pipeline diagram (July 2026), nine dictated explanation blocks plus three annex notes (speech-to-text — names/terms are not 100% reliable; intent prevails over literal wording), the owner's ChatGPT exchange on sources of truth (kept as project knowledge, confronted and adapted below), a 5-agent audit of the current codebase, and a 14-agent adversarial verification of this document against the full requirement inventory (§9). Status: **implemented** — all 14 gaps (G1–G14) landed on branch evolution/v0.5.0 (July 3, 2026); this document remains the contract of record for what was built.

This evolution is large enough to jump the project version to **0.5.0**.

## 0. Purpose, method, delivery

**Purpose.** Vivicy already does a lot, but the UX is confusing and the engine underneath is invisible: what runs, where it is, what failed is not visible or drivable from the interface. This evolution uses the pipeline to confirm what the engine already does, reinforce it where it is weak, and expose it in the UI (buttons, indicators, information) so the engine becomes visible and drivable.

**Goal.** Vivicy takes a user end-to-end: from writing the spec (or importing one) to the fully developed final product, in any language, autonomously. The target may be an empty repo (greenfield: everything is built from the canonical) or an existing codebase (brownfield: the canonical describes the evolution/feature Vivicy governs on top of the current code — the S8 readiness check is what makes this safe). Vivicy is an agent orchestrator that governs code, whatever the starting state.

**Method (non-negotiable).** State-of-play audit by an agent team before any development (done — §2); evolve the existing engine; never restart from zero; never overwrite working machinery. Every gap below lands as an extension of the audited modules it names. The owner also explicitly invites pushback: this document must correct him and propose better options where they exist (it does, §6), not merely transcribe.

**Delivery.** The totality of this scope is developed end-to-end in one development effort — not phases spread over time. The build order in §7 is an internal dependency ordering inside that single effort, nothing more.

## 1. Operating principles (apply to every gap)

- P1 — **No fakery**: every safety/traceability/coverage/progress mechanism must be genuinely verified and enforced by the orchestrator. Producing a report, matrix, or hash that nothing downstream checks is forbidden. Deterministic wherever possible.
- P2 — **Zero humans in the dev-loop**: the autonomous side runs with no human step. Exactly one legitimate human touchpoint exists in the whole system: the owner decision on a change request (an intention change). Retry buttons (§G8) are human interventions *on* the machine, never steps the machine waits for.
- P3 — **Absolute rigor as consequence of P2**: because no human watches the loop, the discipline must be extreme — hard gates, loud failures, no silent loss, no blind states. Being blind about what happened, where, or why is forbidden.
- P4 — **Never leave an error standing**: on any detected problem the orchestrator remediates automatically (re-extract, correct, re-freeze, re-gate) within bounded attempts; if bounds are exhausted it blocks *loudly* (report + notification), never silently. The loop must always either progress or surface a block.
- P5 — **Flexibility inside determinism**: agents must not act "like brutes" grabbing work blindly. The system embeds human-like judgment legs (readiness verdicts, proof verdicts) at decision points, while the orchestration around them stays deterministic and evidence-based.
- P6 — **ShadcnUI only, everywhere**: design tokens, components, and pages all come from ShadcnUI. Nothing is hand-invented in raw Tailwind. This applies to all UI work in this document, not just the chat.
- P7 — **Non-loop / dev-loop boundary**: left of the boundary (spec creation: import, Vivi conversation) there is no automatism — only a user↔Vivi discussion. Right of it, everything is autonomous. The pipeline UI (§G8) must preserve and display this boundary.
- P8 — **Stage typing**: every stage is typed deterministic (🖥️ — strongly or totally deterministic), agent (🤖 — performed by an LLM: Claude or Codex), or mixed (🖥️🤖). §3 assigns the type per stage; the UI displays it.
- P9 — **Notifications at every step**: each pipeline step, including autonomous dev-loop internals, reports where the system is, what succeeded, what failed, and what is being redone (e.g. "re-extracting issues after verification found 2 missing"). See §G9.
- P10 — **No useless work**: the canonical never chases the code. Doc updates happen only when intention changes (§4), never to mirror code evolution.

## 2. Current engine — audited and fact-checked state

Every claim below was verified against source by independent agents (one claim corrected during fact-check, noted inline).

| Capability | Status | Evidence |
|---|---|---|
| Freeze + hash verification | ✅ | doc-baseline.mjs:138/143 — SHA-256 document_set_hash + manifest_hash (computeDocumentSetHash :364-370, computeManifestHash :372-383); prior frozen baselines stamped superseded (:601-636). Enforcement is asymmetric by design: at extraction start a mismatch triggers autonomous re-freeze (extract-issues.mjs:140,202-216); at dev-loop entry it is a hard gate that throws (dev-loop.mjs:1471) |
| Extraction two-agent loop | ✅ | extract-issues.mjs: Claude extractor authors corpus → 5 deterministic gates (semantic-extraction, traceability, spike, reference, change-control) → Codex fidelity verdict (faithful:true required) → 8-lens map review (map-review.mjs) → bounded retries re-prompting the extractor |
| Auto spec-correction during extraction | ✅ | Extractor may edit .vivicy/canonical to fix contradictions; orchestrator detects hash mismatch, re-freezes autonomously, continues (extract-issues.mjs:202-216) |
| 100% coverage accounting | ✅ | semantic-extraction-check.mjs: every canonical line covered, governed-excluded, or auto-excluded; uncovered lines fatal outside in-progress tolerance |
| Two-agent dev loop | ✅ | dev-loop.mjs: distinct implementer/reviewer CLIs enforced (R12, resolveAgentLegs :145-176); orchestrator re-runs the verification gate itself, never trusts agent claims |
| Parallel dev ≤12 worktrees | ✅ | runLoopParallel: per-issue git worktrees, independence gate (no transitive deps + disjoint claims), max-spread batch selection, integration lock, conflict aborts and blocks only that issue, frozen-artifact reset pre-merge. **No post-merge re-verification exists** (→ G6) |
| Detached loop (the "PM2 idea") | ✅ | node-spawner.ts spawnDetached (detached:true + unref): supervisor survives Next.js server restart; UI reattaches via run-lock (lib/control.ts). PM2 unnecessary — the property the owner wanted (update/restart Vivicy while the loop keeps developing Naight) already holds. Machine shutdown kills everything, as expected |
| CR registry | ✅ | change-control.mjs: CR-NNNN files, 8-status lifecycle (idea → under_review → accepted_current_build → docs_applied / accepted_future / rejected / implemented / superseded), owner-decision evidence required on decided statuses, previous_*/resulting_* baseline identity chained; re-drive.mjs mechanically reopens impacted issues via excerpt drift. **All transitions manual today** (→ G7) |
| Empty-canonical guard | ❌ bug | lib/control.ts:442-475 spawns extraction with no check that canonical holds real content; template README alone launches agents that spin (→ G11) |
| Chat / notifications / pipeline widget | ❌ | No chat UI or endpoint; sonner toasts only (ephemeral); no stage widget (aggregate progress bar + phase pill only); top-center over the ReactFlow map is free, ViewportPortal available (→ G2, G8, G9) |
| Naight import compatibility | ✅ 100% | _naight-docs: 34 canonical docs, 21 spikes (inter-spike gating already valid), architecture-map.yml — byte-compatible with the .vivicy contract. Copy as-is, one re-freeze, one extraction. Zero normalization |

## 3. Target pipeline — stage by stage

Stage typing per P8. Loop-backs are part of the contract, not exceptions. The "can be retried" bracket (§G8) spans the whole dev-loop side, S2→S12 (as drawn on the diagram, from spike extraction/integration through Done): any stage can be relaunched manually from the UI after a failure.

**Non-loop side (no automatism, user ↔ Vivi only):**

- **S0 — Onboarding** (🖥️ + user): choose the project start — (a) import existing docs, (b) build the spec conversing with Vivi, (c) open a project that already carries a .vivicy. → G10.
- **S1 — Spec + spikes intake**, two paths:
  - **Import** (owner's primary personal path, built for the Naight case): any text files (.md, .doc, .txt, …) via drop zone or picker — individual files, a folder, or a zip. Vivicy **checks first, then places**: verification (no drift, no contradictions, zero modification of the intention) runs on the staged upload, and only then is content normalized to MD and routed to .vivicy/canonical, .vivicy/development/spikes, .vivicy/architecture-map/. → G1.
  - **Vivi** (for users who did no prior spec work — Vivicy helps them from spec writing to finished product): a relatively technical chatbot; the user can ask explanation questions; Vivi grills the user (grill-me style, §G2) and writes only MD files — the canonical, and spikes too, which eases the extractor later (fewer spikes left to extract). → G2.

**Dev-loop side (autonomous):**

- **S2 — Extract from canonical OR integrate existing spikes** (🤖): if no spikes exist, extract them from the canonical; if spikes were uploaded or Vivi-written, **integrate** them — check against the canonical, update contents only if needed, never rewrite, never re-extract. → G12.
- **S3 — Verify spikes / check the proofs** (🤖, in the **target repo** directly): substance, not form (form was S2). Investigate each spike's claims and prove its hypotheses. Cross-agent by design: **Claude establishes the proof, Codex verifies the verification** — protection against hallucinated proofs (a proof rarely survives two different models). Outcomes: (a) hypothesis proven → spike marked verified, canonical untouched; (b) reality differs → once definitive proof of the actual behavior exists, the canonical is updated **only as necessary**, then the spike is marked verified. Pre-freeze this update is a direct edit (truth-model rule 1 zone); post-freeze re-verification routes through a CR (rule 2). Fully automatic, non-human. → G3.
- **S4 — Freeze baseline + verify hash** (🖥️): freeze the canonical; verify hashes; the entire downstream chain rests on the freeze and must fail on violations — otherwise freezing is pointless (P1). Already solid (§2), asymmetric enforcement noted there.
- **S5 — Extract or Reuse map + verify** (🖥️🤖 mixed: extraction is agentic, verification is deterministic parse + lens review): extract the map from the canonical (works today) OR reuse a provided map — the owner brings his own — updating and verifying it **without re-extraction**. → G4.
- **S6 — Extract issues** (🤖): runs only after spikes are verified (ordering enforced → G13). If extraction fails on spec incoherence(s) — rare, the canonical is multi-verified by then — the spec is corrected automatically by an agent and the loop re-enters just before S4: re-freeze, and re-extract the map if the change touched it. Ruling on the owner's hesitation in §6.1; design point "delegate the fix to a second agent" ruled in §6.7.
- **S7 — Verify issues** (🤖 + 🖥️ gates): issues must stick to the canonical with **strictly nothing forgotten**. On ANY problem the orchestrator remediates automatically (P4): re-extract totally-wrong issues, extract missing issues, correct existing issues — then re-verifies. Never leaves an error standing; blocks loudly only after bounded attempts.
- **S8 — Readiness check (non-linear dev)** (🤖): before an issue enters development it is confronted with the **current code**: is it implementable now, at this point of the timeline? Did the code derive since extraction? Identical in parallel mode: the entire next batch (up to 12) is verified against current integration HEAD **before** entering development. Verdict per issue: implementable / issue-update (execution detail) / needs-CR (intention problem). → G5.
- **S9 — Implement + Review** (🤖): existing two-agent loop (§2), sequential or parallel up to 12 — parallelism is what keeps very large projects from taking weeks of sequential development.
- **S10 — Merge integrity** (🖥️ + 🤖 on conflict): merges must lose **nothing** — a silent loss with no final full reverification leaves you blind about which issue and which moment lost code, and blind states are forbidden (P3). Deterministic post-merge re-gate + bounded merge-resolver agent. → G6.
- **S11 — Change requests** (🤖 + owner decision): CRs can come from several sources — an open set, not a closed list: user input to Vivi **mid-run**, spike verifications, a developing agent that hits an impossibility mid-dev after passing every barrier, issue extraction/verification, etc. Agent-emitted CRs surface in the notification center for the **human decision** (P2's single touchpoint). An accepted CR that touches the canonical **always forces a re-freeze** (owner asked for confirmation: confirmed — that is exactly the dotted arrow of the diagram, and the registry already chains baseline identities). → G7.
- **S12 — Done (everything is OK)** (🖥️): explicit terminal state, not to be forgotten: every issue implemented and reviewed, all CRs decided and folded or deferred, all merges integrated and post-verified, non-linear checks clean, all gates green — final code delivered. The supervisor already detects "all issues done"; §G8 gives the state a face.

## 4. Truth model (adopted, from the owner's ChatGPT exchange)

There is **no single universal source of truth** — one source of truth per type of truth:

| Truth type | Source |
|---|---|
| Product intention | canonical spec + accepted change requests |
| Work to do | issues |
| Real result | code + tests |
| Conformity proof | gates + traceability |

Rules, mapped to the pipeline:

1. **Ambiguity detected during extraction** (pre-build): modify the spec directly, re-freeze, re-extract. A lightweight spec correction before engagement — no heavy CR. (= S6's auto-correction, already implemented.)
2. **A spike discovers a real constraint**: CR mandatory — new technical knowledge changes product intention. The spike must **not** modify the spec directly; it proposes. (Post-freeze; pre-freeze spike proving may edit directly, §3-S3.)
3. **The need changes during development**: CR mandatory. The CR is the official mechanism to say "the initial intention is no longer right".
4. **An issue becomes non-implementable because of already-produced code**: execution-plan problem (ordering, dependency, split, missing prerequisite) → modify the **issue** only; product-intention problem (false, contradictory, insufficient intention) → **CR toward the spec**. Short form: plan problem → issue; intention problem → spec via CR.

Structural rules:

- canonical = current consolidated intention; change requests = decision history; baselines = verifiable snapshots over time.
- An accepted CR must eventually be **folded into the canonical** — never an old spec plus infinite annexes; that becomes unreadable.
- **Current product contract = latest canonical baseline + accepted CRs not yet folded.**
- Issues are never the product truth (operational projection of it); code is never the product truth (it is the result) — otherwise "is the code conform to what we wanted?" becomes unanswerable.
- A CR is **not** for aligning docs onto code; it officially changes product intention. The spec is updated **only** when the intention changes, never merely because the code evolved (P10).

## 5. Gaps — full specifications

### G1. Upload & normalization of external docs (S1-import; owner's priority)
Nothing exists today (audit: app/api/fs has list/mkdir only; no upload, no normalization, no import dialogue). Build:
- UI: drop zone + file picker; three modes: individual files, folder, zip.
- Staging + check-then-place: uploads land in a staging area; an agent leg verifies no drift, no contradictions, zero intention rewrite; a report is produced; only on green is content normalized (.md pass-through; .txt/.doc/.docx → MD via agent leg, intention preserved verbatim) and routed to .vivicy/canonical, .vivicy/development/spikes, .vivicy/architecture-map/.
- Failure path: red check → nothing placed, report + notification explain exactly what drifted/contradicted.
- Naight: zero normalization (§2); the flow must still run its check.
- Acceptance: from a fresh Vivicy, importing _naight-docs via the UI yields a verified, placed corpus ready for S2 without touching a terminal.

### G2. Vivi — the chatbot (S1-chat)
Nothing exists (no chat components, no endpoint, no "Vivi" anywhere). Build:
- **Vivi is the named agent persona living in Vivicy** — a UX touch: Vivi asks the questions; Claude or Codex exec runs underneath.
- Purpose: serve users with no prior spec work, end-to-end — from spec writing to finished product. Relatively technical by design; the user can ask explanation questions mid-session.
- Interrogation: **inspired by Matt Pocock's grill-me skill — inspiration only, not verbatim, and pushed further/more powerful**. Vivi grills the user with many questions to fill every hole until no doubt remains in the spec; the user answers everything rather than the agent imagining answers.
- Writes **only MD files** into .vivicy: the canonical, and **spikes too** — easing the extractor's later work (fewer spikes left to extract).
- Agent selection: Claude or Codex, from the existing settings; agent settings are **not** configurable from the chat (they live in Vivicy's settings UI).
- UI: exclusively ShadcnUI (P6). Candidate components supplied by the owner: message-scroller, attachment, bubble, marker, message, plus scroll-fade and shimmer utilities; browse the current shadcn site/changelog for the full up-to-date list of useful primitives before building; add missing installed primitives (textarea, …).
- Endpoint: /api/vivi driving the configured agent CLI in exec mode.
- Acceptance: a user with an empty project reaches a canonical + spikes corpus that passes S2 checks, purely through conversation.

### G3. Spike prover — substance verification (S3)
spike-check.mjs validates form only; "verified" today requires hand-written evidence — a human, which contradicts the autonomous dev-loop. Build:
- Prover leg: Claude (implementer CLI, new role spike-prover) executes the spike's experiments **in the target repo**, captures the six evidence fields (environment, commands, observed output, decision, documentation updates, unresolved risks).
- Counter-verification leg: Codex (reviewer CLI, new role proof-verifier) independently verifies the proof — the due-diligence against hallucinated proofs. Only on agreement does the orchestrator flip status.
- Leg assignment ruling (owner asked who should run it — implementer or reviewer): **both, as above** — reuse the existing leg infrastructure with two new roles, preserving the R12 distinct-CLI invariant. Not a third CLI.
- Outcomes: proven → verified, canonical untouched (updated **only if necessary**); disproven → status failed + auto-drafted CR (status idea), because a false assumption is an intention-level event (rule 2).
- Ruling on `/_verified` folder (owner's question, analogy with issues done/): **no folder move**. For issues, done/ is the physical state machine; for spikes the status field in the traceability block is already the machine truth consumed by gating — a parallel folder would duplicate state. The UI surfaces verification state instead (G8/sidebar).
- Acceptance: on the Naight corpus, at least one spike goes pending → proven/failed with orchestrator-captured evidence and zero human edits.

### G4. Reuse-and-verify imported map (S5)
The extractor refines an existing map in place and --reconcile-against exists, but there is no import path and no verify-without-re-extraction mode. Build: map import via G1 + a verify-only mode — deterministic parse gate (generate-viewer-data) + 8-lens agent review against the frozen baseline, with the extractor prompted to update, never to re-author. Acceptance: Naight's architecture-map.yml imported, verified, refined in place — its layout preserved.

### G5. Per-issue readiness check — non-linear dev (S8)
Issues are consumed as-extracted today; nothing confronts issue N with the code produced by issues 1..N-1. Build:
- Readiness leg before implementation, per issue: verdict implementable / issue-update / needs-CR (rule 4 decides which of the last two).
- issue-update is bounded: execution details only (ordering, dependency, split, prerequisite); cited canonical lines untouched; recorded in the ledger.
- needs-CR: CR drafted (idea), issue parked in a blocked-on-CR state, notification fired — and **the loop keeps running** on other ready issues; if nothing is ready the run pauses loudly. The loop must always progress or block loudly, never dead-end silently (P4); after the owner decides, G7 automation re-drives.
- Parallel mode: the whole selected batch (≤12) is readiness-checked against current integration HEAD before any worktree spawns.
- Acceptance: a deliberately staled issue (fixture) is caught pre-implementation and routed correctly both sequentially and in parallel.

### G6. Merge integrity (S10)
Today a conflict aborts and blocks only that issue; nothing re-verifies after integration — no lost-code detection. Build:
- **Deterministic first**: after every worktree integration, re-run that issue's verification gate on the integration branch. Green pre-merge + red post-merge = the merge damaged something — detection with zero agent judgment (P1).
- **Merge-resolver agent second** (the owner's "dedicated agent" question — ruling: yes, a dedicated bounded leg, not the implementer): on conflict, an agent rebases the worktree onto integration HEAD, re-runs the gate in the worktree, then the orchestrator retries the merge once.
- **Block third**: still failing → issue blocked (current behavior). Never a silent force-merge.
- Acceptance: a fixture with two issues editing the same file yields either a resolved rebase with green post-merge gate, or a loud block — never silent loss.

### G7. CR automation (S11)
Registry, lifecycle, and re-drive exist; every transition is manual; nothing emits CRs from the loop; docs_applied triggers nothing. Build:
- **Emission (open set of sources)**: Vivi chat mid-run (the user talks to Vivi while the loop works; intention-changing input becomes a drafted CR), spike prover failure (G3), readiness/dev/review legs (G5/S9), extraction/verification (S6/S7) — each lands as status idea with source evidence. New sources must be addable without schema change.
- **Decision**: pending CRs surface in the notification center (G9) and sidebar; the owner approves/rejects in the UI; recorded as owner_decision evidence (P2's single human touchpoint).
- **Application chain**: on docs_applied, the orchestrator runs apply → re-freeze → re-extract → re-drive automatically (today's manual sequence, automated). This is the diagram's dotted CR→freeze arrow, confirmed: a CR touching the canonical always forces a re-freeze.
- **Folding**: accepted-not-yet-folded CRs are tracked; folding into the canonical is part of the application chain (§4 structural rules), keeping the current-contract formula true.
- Acceptance: a CR emitted by an agent reaches the UI, is approved, and the chain lands a new frozen baseline with impacted issues reopened — no terminal.

### G8. Pipeline widget + full process view (S0–S12 visibility)
No stage visualization exists. Build:
- **Mini-pipeline overlay**: top-center **over the map canvas** (overlay above the ReactFlow viewport, not a DOM band above it; ViewportPortal or absolutely-positioned layer). A small technical schema — very graphic yet explicit, clear, simple: all stages with arrows, mirroring the diagram including the non-loop/dev-loop boundary (P7); per-stage 🖥️/🤖/🖥️🤖 markers (P8); color changes for state (pending/running/green/red); current-stage highlight; which loop is currently running; visible backward/forward movement when the system re-enters an earlier stage (e.g. CR → re-freeze).
- **Actions**: per-stage retry buttons — the "can be retried" bracket: a human may relaunch/re-test stages after an error. Confirm dialogs on **all sensitive actions** (retry, stop, CR decisions), not just retry.
- **Full process view**: the owner's noted variant — a complete state view (modal or sidebar; recommendation: sidebar section + modal detail on stage click) spanning freeze through extraction to dev, with timings and evidence links.
- Acceptance: during a Naight run, a user can tell at a glance which stage runs, what re-entered, what failed, and can retry a failed stage with confirmation.

### G9. Notification center
Only ephemeral sonner toasts exist. Build:
- **Bell icon** in the top bar next to the agent settings, with unread badge; a notification list — like logs, but nicer; every notification dismissable/deletable.
- Fired at every step (P9): stage transitions, successes, failures, automatic redos ("re-extracting canonical", "re-extracting issues"), CR submissions awaiting decision, blocks.
- Storage: 100% local, no database — owner offered browser IndexedDB (keyed per run, surviving window close/reopen) or JSON in the repo; **ruling: JSON under .vivicy-runtime/** — server-authoritative, survives any browser, one source of truth for every client; explicitly no SQLite for mere notifications (keep it simple).
- Acceptance: close and reopen the browser mid-run — the full notification history for the run is intact and dismissable.

### G10. Onboarding revamp (S0)
Today's onboarding is confusing — folder selection was even duplicated in the past (the owner removed one instance); the two current dialogs predate the pipeline. Build: after target selection, three explicit starts — import existing docs (G1: files/folder/zip) / build the spec with Vivi (G2) / open a project already carrying a .vivicy. Plus G11. Design seam (for §8-F1): onboarding keeps **target acquisition** (how the repo gets on disk — local folder today, GitHub clone tomorrow) strictly separate from **spec intake** (import / Vivi) — the two axes compose, they are not sibling menu entries. Acceptance: a first-time user reaches each of the three paths without dead ends or duplicate choices.

### G11. Empty-canonical guard (bug fix)
Confirmed: lib/control.ts:442-475 spawns extraction with no pre-flight content check; with a template-only canonical, the **"Extract from docs" button** launches agents into the void and stays blocked spinning ("no issues extracted yet" while it runs). Fix: deterministic guard — canonical contains at least one real (non-template) doc — before spawn; clear UI error otherwise. The pipeline's stage states (G8) make the broken sequence structurally impossible; this guard stays as defense in depth (P1).

### G12. Spike integrate-or-extract mode (S2)
Today spikes are authored during extraction; there is no integrate-uploaded-spikes path. Build: when spikes exist (uploaded via G1 or Vivi-written), S2 checks them against the canonical and updates only what is needed — integrate, never rewrite, never re-extract; when none exist, extract from the canonical as today. Naight's 21 spikes pass through the integrate path untouched (byte-compatible). Acceptance: imported spikes keep their identity (gate_ids, gating graph) through S2 and reach S3 unmodified except necessary updates.

### G13. Extraction gated on verified spikes (S6 ordering)
Today spike gates gate dev-loop issue picks, not extraction; the diagram places issue extraction after spike verification. Build: S6 requires the spike corpus proved (G3) — spikes verified/deferred per their gating graph — before issue extraction proceeds; the orchestrator enforces the S2→S3→S4→S5→S6 order end-to-end. Acceptance: extraction refuses to run (loud, notified) while a required spike is pending/failed.

### G14. Agent-drivable control surface (CLI + API parity)
The engine is already headless-first (factory/cli.mjs: app|loop|status; detached supervisor; the Next.js UI is just a client), but the control surface is split — some verbs exist only as Next API routes — and outputs are not machine-consumable. Build:
- One control plane (lib/control.ts stays the single implementation), two clients: the Next API routes (UI) and the `vivicy` CLI (agents), exposing the **same verbs**: status, extract, start, stop, resume, retry-stage, notifications, crs list / cr approve / cr reject.
- CLI contract for non-human callers: stable JSON output, stable exit codes, no interactive prompts — designed to be driven by an agent (Claude/Codex) interrogating or steering a running pipeline while the UI is closed. The interface can be killed at any time; the detached process keeps working; the CLI reattaches through the same run-state the UI uses.
- G7's CR decision and G8's per-stage retry are implemented as control-plane verbs first, then bound to UI buttons and CLI subcommands — never as UI-only logic.
- Acceptance: with the Vivicy server stopped mid-run, `vivicy status --json` reports the live pipeline stage, and `vivicy cr approve CR-0001` + `vivicy retry-stage S6` steer it — then reopening the UI shows the same state.

## 6. Rulings on the owner's open questions

1. **Spec incoherence at extraction — fix the spec or fix the issues?** Fix the spec. Pre-build correction is cheap and legitimate (rule 1); the mechanism exists and re-freezes autonomously. Never patch issues around a known-bad spec — that silently promotes issues to a second source of truth, violating §4.
2. **`/_verified` folder for spikes?** No — status field stays the single machine truth; UI displays it (G3). The done/ analogy fails because done/ is the issues' physical state machine, while spikes already have a status state machine.
3. **Who resolves merge conflicts?** Deterministic post-merge re-gate first, dedicated bounded merge-resolver agent second, loud block third (G6). Never silent.
4. **Issue stale at implementation time — CR, modification, light update, correction?** Readiness leg with rule-4 routing: execution detail → bounded issue-update; intention problem → CR. In all cases the loop keeps running or blocks loudly — it never dead-ends (G5).
5. **Humans in the loop?** Exactly one touchpoint: the CR owner decision. Retry buttons are interventions, not awaited steps (P2).
6. **Does an accepted CR force a re-freeze?** Yes — confirmed. Any CR whose application touches the canonical produces a new frozen baseline (the registry already chains previous_/resulting_ identities); the automation chain makes it mechanical (G7).
7. **Should the extractor delegate the spec fix to a second specialized agent (or Vivi)?** No — keep the extractor's self-fix (existing, working): it holds the failure context, and a hand-off would add a lossy hop for no verification gain. The independent Codex fidelity verdict already cross-checks the result. Vivi stays a non-loop persona (P7).
8. **Which leg runs the prover?** Claude proves, Codex counter-verifies — two new roles on the existing leg pair (G3), preserving R12.
9. **PM2?** Not needed — the detached supervisor already provides the property (§2); remaining work is UI visibility (G8) of the reattached run.

## 7. Build order (one delivery — internal ordering only)

1. G11 guard + target-resolution alignment (existing TASKS.md debt that blocks clean onboarding)
2. G1 import → G12 spike integration → G4 map reuse → G10 onboarding (the Naight path, end-to-end)
3. G13 ordering + G3 prover (autonomy of the spike stage)
4. G5 readiness + G6 merge integrity + G7 CR automation (loop hardening)
5. G2 Vivi (second intake path)
6. G14 control surface → G8 widget → G9 notifications (control verbs first, then the UI and CLI clients that consume them; event-bus stubs land earlier, with each stage they observe)

Everything ships in the same effort; the order only serializes dependencies (events before widget, import before integration modes, verbs before buttons).

## 8. Future anticipations (decided now, built later)

Three owner ideas examined for architectural impact now, while there are no users and breaking changes are free. What lands in v0.5.0 from each is only the cheap structural decision; the features themselves are postponed.

- **F1 — GitHub App** (connect a repository; Vivicy fetches it and governs it as the target — empty repo rebuilt from canonical, or existing repo evolved by a canonical describing the new feature): postponed as a product surface. Landed now: brownfield targets are explicit in the goal (§0) and G10's onboarding seam separates target acquisition from spec intake, so a GitHub-clone acquisition path slots in later without reshaping onboarding. Local git stays the target medium either way — the App would only deliver the clone.
- **F2 — Vivicy Cloud** (paid hosted Vivicy; agents running in Docker sandboxes / VMs / micro-VMs): postponed entirely — not built, not chosen (docker vs micro-VM is a decision for the day cloud work starts). Landed now, as architectural invariants: (a) every agent execution stays behind the single leg-runner interface (agent-spawn.mjs + leg-timeout) with no host-coupled assumptions inside legs, so a containerized runner is a future plug-in, not a rewrite; (b) all mutable runtime state stays under .vivicy-runtime/ (volume-mappable); (c) G14's non-interactive JSON control surface is exactly the remote-control contract a hosted Vivicy would expose.
- **F3 — Agent-driven operation** (agents, not humans, driving Vivicy from outside): not postponed — this is G14 in the v0.5.0 scope.

## 9. Requirement traceability

76 requirements: 73 extracted from the owner's blocks, diagram, and annexes — each verified against this document by independent agents over two adversarial passes — plus 3 post-verification additions (N1–N3, §8). Inventory → coverage:

- M1–M7 (method, purpose, version, delivery) → §0, header
- B1.1–B1.12 (upload, Naight, Vivi, grill-me, ShadcnUI, upload check) → §3-S1, G1, G2, P6
- B2.1–B2.4 (boundary, legend, spike integrate-or-extract) → P7, P8, §3-S2, G12
- B3.1–B3.8 (proofs in target repo, cross-agent, _verified ruling, leg choice) → §3-S3, G3, §6.2, §6.8
- B4.1–B4.4 (freeze, no fakery, map reuse, stage typing) → §3-S4/S5, P1, G4, P8
- B5.1–B5.6 (extraction ordering, auto spec-fix, delegation question, loop-back incl. map, no humans, notifications design) → §3-S6, G13, §6.1, §6.7, G9
- B6.1–B6.3 (nothing forgotten, three remediations, notifications every step) → §3-S7, P4, P9
- B7.1–B7.9 (two agents, ≤12 parallel rationale, merge no-loss, dedicated agent, non-linear dev, batch pre-check, no-brute judgment, fix paths, rigor, flexibility) → §3-S8/S9/S10, G5, G6, P3, P5, §6.3, §6.4
- B8.1–B8.13 (CR sources open set, human validation, re-freeze confirmation, full truth model, rules 1–4, folding, contract formula, negative rules, adaptation mandate) → §3-S11, §4, G7, §6.5, §6.6
- B9.1–B9.4 (Done step, retry bracket, widget spec, modal/sidebar + confirms) → §3-S12, G8
- A1–A3 (onboarding motivation, empty-canonical bug, detached process purpose & limits) → G10, G11, §2
- N1–N3 (post-verification additions: GitHub App / brownfield targets, agent-drivable CLI-API, Vivicy Cloud sandboxing) → §0 Goal, G14, §8
