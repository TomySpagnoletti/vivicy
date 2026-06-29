/**
 * Integration test for the senior static-graph + live-overlay split.
 *
 * Uses the REAL stack end to end — `node:fs/promises.readFile`, `@/lib/target`,
 * `@/lib/map-data.applyLiveOverlay`, and the shared `@/lib/development-overlay`
 * derivation — against a real on-disk target. It proves the load-bearing claim:
 * `/api/map` returns LIVE progress derived from the ledger WITHOUT regenerating
 * the static data file.
 *
 *   - a static architecture-data.json + a ledger with an issue done -> /api/map
 *     shows it done;
 *   - changing only the ledger -> /api/map reflects the change;
 *   - the static data file is BYTE-UNCHANGED across all of the above.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// No module mocks: this exercises the real route + real lib code.
import { GET } from "./route"

const ARCH_REL = ".vivicy/architecture-map/architecture-data.json"
const LEDGER_REL = ".vivicy/development/progress-ledger.json"

/**
 * A minimal STATIC architecture-data.json in the shape the generator emits:
 * nodes/edges carry baked graph_refs, every node is not_started, and the
 * development block holds the STATIC issue list + path pointers + empty overlay.
 */
const STATIC_MAP = {
  version: 1,
  updated: "2026-06-26",
  name: "Overlay Fixture",
  purpose: "prove the read-time overlay",
  nodes: [
    {
      id: "ledger",
      label: "Ledger",
      kind: "service",
      lane: "core",
      order: 1,
      layout_x: 0,
      layout_y: 0,
      layout_cluster: "c",
      layout_role: "primary_flow",
      scope: "mvp",
      status: "not_started",
      tech: "ts",
      owns_data: ["entries"],
      source_refs: [".vivicy/canonical/spec.md:1"],
      graph_ref: "node:ledger",
    },
    {
      id: "cat",
      label: "Categories",
      kind: "service",
      lane: "core",
      order: 2,
      layout_x: 100,
      layout_y: 0,
      layout_cluster: "c",
      layout_role: "support",
      scope: "mvp",
      status: "not_started",
      tech: "ts",
      owns_data: ["categories"],
      source_refs: [".vivicy/canonical/spec.md:2"],
      graph_ref: "node:cat",
    },
  ],
  edges: [],
  development: {
    issue_index_path: ".vivicy/development/issue-index.json",
    progress_ledger_path: ".vivicy/development/progress-ledger.json",
    issues: [
      { id: "ISS-A", title: "Ledger", graph_refs: ["node:ledger"] },
      { id: "ISS-B", title: "Categories", graph_refs: ["node:cat"] },
    ],
    graph_item_states: [],
    active_items: [],
    coverage_summary: null,
  },
}

let root: string
let originalEnv: string | undefined
let originalRuntimeDir: string | undefined

function writeJson(rel: string, value: unknown): void {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`)
}

function archBytes(): Buffer {
  return readFileSync(join(root, ARCH_REL))
}

async function getMapBody(): Promise<{
  development?: { graph_item_states?: Array<{ graph_ref: string; status?: string }> }
}> {
  const res = await GET()
  expect(res.status).toBe(200)
  return res.json()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vivicy-overlay-"))
  // A usable target needs a .vivicy/canonical/ dir (isTargetResolved) and the static map.
  mkdirSync(join(root, ".vivicy", "canonical"), { recursive: true })
  writeJson(ARCH_REL, STATIC_MAP)
  originalEnv = process.env.VIVICY_TARGET_ROOT
  process.env.VIVICY_TARGET_ROOT = root
  // Isolate the runtime dir into the temp root so a persisted current-project on
  // the dev machine never wins over VIVICY_TARGET_ROOT (getTargetRoot prefers a
  // persisted project). The temp root holds no current-project.json, so target
  // resolution falls through to the env above — hermetic regardless of host state.
  originalRuntimeDir = process.env.VIVICY_RUNTIME_DIR
  process.env.VIVICY_RUNTIME_DIR = root
  vi.resetModules()
})

afterEach(() => {
  if (originalEnv === undefined) delete process.env.VIVICY_TARGET_ROOT
  else process.env.VIVICY_TARGET_ROOT = originalEnv
  if (originalRuntimeDir === undefined) delete process.env.VIVICY_RUNTIME_DIR
  else process.env.VIVICY_RUNTIME_DIR = originalRuntimeDir
  rmSync(root, { recursive: true, force: true })
})

describe("/api/map live overlay (real stack, no regeneration)", () => {
  it("derives DONE progress from the ledger and leaves the data file byte-unchanged", async () => {
    const before = archBytes()

    // A ledger marking ISS-A's node verified — the single source of truth.
    writeJson(LEDGER_REL, {
      graph_item_states: [
        {
          graph_ref: "node:ledger",
          status: "verified",
          issue_ids: ["ISS-A"],
          evidence_refs: [".vivicy/development/gates/ISS-A.json:1"],
          transcript_refs: [".vivicy/development/transcripts/ISS-A/impl.jsonl"],
        },
      ],
      active_items: [],
    })

    const body = await getMapBody()
    const states = body.development?.graph_item_states ?? []
    expect(states.find((s) => s.graph_ref === "node:ledger")?.status).toBe("verified")

    // The data file was NOT regenerated — same bytes as before the request.
    expect(archBytes().equals(before)).toBe(true)
  })

  it("reflects a CHANGED ledger on the next read, still without touching the data file", async () => {
    const before = archBytes()

    // First: nothing done.
    writeJson(LEDGER_REL, { graph_item_states: [], active_items: [] })
    let body = await getMapBody()
    expect(body.development?.graph_item_states ?? []).toHaveLength(0)

    // Then: mark BOTH issues verified — only the ledger changes.
    writeJson(LEDGER_REL, {
      graph_item_states: [
        {
          graph_ref: "node:ledger",
          status: "verified",
          issue_ids: ["ISS-A"],
          evidence_refs: [".vivicy/development/gates/ISS-A.json:1"],
        },
        {
          graph_ref: "node:cat",
          status: "verified",
          issue_ids: ["ISS-B"],
          evidence_refs: [".vivicy/development/gates/ISS-B.json:1"],
        },
      ],
      active_items: [],
    })

    body = await getMapBody()
    const verified = (body.development?.graph_item_states ?? []).filter((s) => s.status === "verified")
    expect(verified.map((s) => s.graph_ref).sort()).toEqual(["node:cat", "node:ledger"])

    // Across both reads and the ledger rewrite, the static data file never changed.
    expect(archBytes().equals(before)).toBe(true)
  })

  it("renders the static graph (no progress) when no ledger exists yet", async () => {
    const before = archBytes()
    // No ledger written — a target mid-extraction.
    const body = await getMapBody()
    expect(body.development?.graph_item_states ?? []).toHaveLength(0)
    expect(archBytes().equals(before)).toBe(true)
  })
})
