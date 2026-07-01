// Parser regression tests for parseArchitectureMap (generate-viewer-data.ts).
//
// These lock the EXACT supported architecture-map.yml shape the extractor prompt
// documents, after a live extraction run authored a top-level `clusters:` section
// the parser rejects. The orchestrator now runs map generation as a validation
// GATE; these tests pin the parser contract that gate enforces:
//   - clusters are expressed PER NODE via `layout_cluster`, which PARSES, and
//   - a top-level `clusters:` section THROWS the exact "Unsupported …" error the
//     gate feeds back to the extractor.
import { tmpdir } from "node:os"

import { beforeAll, describe, expect, it } from "vitest"

// generate-viewer-data.ts resolves a target project at module-load time and exits
// if VIVICY_TARGET_ROOT is unset. We only need the PURE parser, so we point the env
// at a throwaway dir and import the module dynamically AFTER setting it. The parser
// itself reads no files — it just parses the YAML string we pass.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let parseArchitectureMap: (source: string) => any
let reconcileLayout: (reference: string, current: string) => { source: string; restored: string[] }

beforeAll(async () => {
  process.env.VIVICY_TARGET_ROOT = tmpdir()
  ;({ parseArchitectureMap, reconcileLayout } = await import("./generate-viewer-data"))
})

// A minimal but complete map in the supported style: clusters live on each node
// as `layout_cluster`, never as a top-level section.
const SUPPORTED_MAP = `version: 1
updated: "2026-06-22"
name: "Parser Test Map"
purpose: "Lock the supported architecture-map.yml shape."
generated_artifact_path: ".vivicy/architecture-map/architecture-data.json"
evidence_ref_grammar: "path[:line][#anchor]"
verification_gate_ref_grammar: "^.vivicy/development/(gates|reports)/.+"

source_baseline:
  id: "baseline-2026-06-test"
  baseline_id: "baseline-v1.0.0"
  baseline_version: "1.0.0"
  manifest_path: ".vivicy/baselines/baseline-v1.0.0.json"
  manifest_hash: "abc"
  document_set_hash: "def"
  captured_at: "2026-06-22"
  repo_root: "."
  included_docs:
    - ".vivicy/canonical/**/*.md"
  excluded_globs:
    - "docs/governance/**"
  source_ref_grammar: "path[:line][#anchor]"

kind_taxonomy:
  - actor
  - service

kind_definitions:
  - "actor: external human that originates intent"
  - "service: module that owns behavior"

flow_classes:
  - "user request to stored record"

high_risk_kinds:

rules:
  - "Edit architecture-map.yml only. Generated viewer data is a build artifact."

status_legend:
  not_started: "Documented target, implementation not started."
  verified: "Implemented and passed required verification gates."

views:
  target:
    title: "Target Architecture"
    subtitle: "Complete planned system graph."
  progress:
    title: "Development Progress"
    subtitle: "Same graph, colored by progress overlay."

lanes:
  - id: entry
    label: "User Entry"
  - id: core
    label: "Core Library"

nodes:
  - id: user
    label: "User"
    kind: "actor"
    lane: entry
    order: 10
    layout_x: -160
    layout_y: 0
    layout_cluster: "entry"
    layout_role: primary_flow
    scope: mvp
    status: not_started
    tech: "Human user"
    owns_data: ["request intents"]
    source_refs: [".vivicy/canonical/01-architecture.md:21"]
  - id: service
    label: "Service"
    kind: "service"
    lane: core
    order: 20
    layout_x: 200
    layout_y: 0
    layout_cluster: "core"
    layout_role: shared_state
    scope: mvp
    status: not_started
    tech: "Core module"
    owns_data: ["records"]
    source_refs: [".vivicy/canonical/02-model.md:11"]

edges:
  - from: user
    to: service
    relation: "issues requests"
    protocol: "Module call"
    data: ["request record"]
    source_refs: [".vivicy/canonical/02-model.md:11"]
`

describe("parseArchitectureMap — supported shape", () => {
  it("parses nodes with per-node layout_cluster (the supported way to express clusters)", () => {
    const map = parseArchitectureMap(SUPPORTED_MAP)
    expect(map.nodes.map((n: { id: string }) => n.id)).toEqual(["user", "service"])
    // Clusters are carried on each node, NOT a top-level section.
    expect(map.nodes.map((n: { layout_cluster: string }) => n.layout_cluster)).toEqual(["entry", "core"])
    expect(map.lanes.map((l: { id: string }) => l.id)).toEqual(["entry", "core"])
    expect(map.edges).toHaveLength(1)
    expect(map.edges[0]).toMatchObject({ from: "user", to: "service" })
    // A top-level `clusters` property is never produced.
    expect(map.clusters).toBeUndefined()
  })
})

describe("parseArchitectureMap — rejects the live-run failure shape", () => {
  it("throws the exact 'Unsupported architecture-map.yml line' error on a top-level clusters: section", () => {
    // This is the precise corpus the live extraction authored: a top-level
    // `clusters:` list with `- id: …` items. The strict parser rejects it.
    const withTopLevelClusters =
      SUPPORTED_MAP +
      `
clusters:
  - id: pipeline
    title: "Pipeline"
    description: "The processing pipeline."
`
    expect(() => parseArchitectureMap(withTopLevelClusters)).toThrow(
      /Unsupported architecture-map\.yml line:\s+- id: pipeline/,
    )
  })

  it("throws on any other unsupported top-level section", () => {
    const withUnknownSection = SUPPORTED_MAP + `\nbogus_section:\n  - one\n`
    expect(() => parseArchitectureMap(withUnknownSection)).toThrow(/Unsupported architecture-map\.yml line/)
  })
})

describe("reconcileLayout — self-heal owner placements", () => {
  // The extractor "moved" the user node: new x and a different cluster.
  const moved = SUPPORTED_MAP.replace("layout_x: -160", "layout_x: 999").replace('layout_cluster: "entry"', 'layout_cluster: "moved"')

  it("restores a moved node's position and cluster to the owner's reference", () => {
    const { source, restored } = reconcileLayout(SUPPORTED_MAP, moved)
    expect(restored.some((entry) => entry.startsWith("node user"))).toBe(true)
    const healed = parseArchitectureMap(source)
    const user = healed.nodes.find((n: { id: string }) => n.id === "user")
    expect(user.layout_x).toBe(-160)
    expect(user.layout_cluster).toBe("entry")
    // The untouched node keeps its position.
    const service = healed.nodes.find((n: { id: string }) => n.id === "service")
    expect(service.layout_x).toBe(200)
  })

  it("is a no-op when the layout already matches (no restoration, source unchanged)", () => {
    const { source, restored } = reconcileLayout(SUPPORTED_MAP, SUPPORTED_MAP)
    expect(restored).toEqual([])
    expect(source).toBe(SUPPORTED_MAP)
  })

  it("never throws on a malformed reference — it heals nothing and WARNS (not silent)", () => {
    const { source, restored, warning } = reconcileLayout("clusters:\n  - id: bad\n", moved)
    expect(restored).toEqual([])
    expect(source).toBe(moved)
    expect(warning).toBeTruthy()
  })
})
