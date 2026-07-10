import { describe, expect, it, vi } from "vitest"

import {
  deriveDevelopmentOverlay,
  edgeGraphRef,
  nodeGraphRef,
  type DeriveOverlayOptions,
} from "@/lib/development-overlay"

const GRAPH_REFS = new Set(["node:ledger", "node:cat", "edge:ledger->cat:writes:mcp"])
const ISSUES = [
  { id: "ISS-A", graph_refs: ["node:ledger"] },
  { id: "ISS-B", graph_refs: ["node:cat"] },
]

function options(ledger: unknown, extra: Partial<DeriveOverlayOptions> = {}): DeriveOverlayOptions {
  return {
    graphRefs: GRAPH_REFS,
    issues: ISSUES,
    ledger,
    verificationGateMatcher: /gate/i,
    ...extra,
  }
}

describe("nodeGraphRef / edgeGraphRef", () => {
  it("builds the canonical node ref", () => {
    expect(nodeGraphRef("ledger")).toBe("node:ledger")
  })

  it("builds the canonical edge ref, slugging relation + protocol", () => {
    expect(edgeGraphRef({ from: "ledger", to: "cat", relation: "writes", protocol: "mcp" })).toBe(
      "edge:ledger->cat:writes:mcp"
    )
  })

  it("tolerates a missing relation/protocol", () => {
    expect(edgeGraphRef({ from: "a", to: "b" })).toBe("edge:a->b::")
  })
})

describe("deriveDevelopmentOverlay", () => {
  it("returns an empty overlay for an absent ledger", () => {
    expect(deriveDevelopmentOverlay(options(undefined))).toEqual({
      graph_item_states: [],
      active_items: [],
    })
    expect(deriveDevelopmentOverlay(options(null))).toEqual({
      graph_item_states: [],
      active_items: [],
    })
  })

  it("derives verified graph item states from the ledger", () => {
    const ledger = {
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
    }
    const overlay = deriveDevelopmentOverlay(options(ledger))
    expect(overlay.graph_item_states).toHaveLength(1)
    expect(overlay.graph_item_states[0]).toMatchObject({
      graph_ref: "node:ledger",
      status: "verified",
      issue_ids: ["ISS-A"],
    })
    expect(overlay.active_items).toEqual([])
  })

  it("derives active items from the ledger", () => {
    const ledger = {
      graph_item_states: [],
      active_items: [
        {
          id: "ai-1",
          actor: "claude-implementer",
          issue_id: "ISS-B",
          graph_refs: ["node:cat"],
          state: "working",
          role: "implementer",
          heartbeat_at: "2026-06-26T10:00:00.000Z",
        },
      ],
    }
    const overlay = deriveDevelopmentOverlay(options(ledger))
    expect(overlay.active_items).toHaveLength(1)
    expect(overlay.active_items[0]).toMatchObject({
      id: "ai-1",
      issue_id: "ISS-B",
      state: "working",
      role: "implementer",
    })
  })

  it("requires a verification-gate evidence_ref for a verified item", () => {
    const ledger = {
      graph_item_states: [
        {
          graph_ref: "node:ledger",
          status: "verified",
          issue_ids: ["ISS-A"],
          evidence_refs: [".vivicy/development/notes.md:1"],
        },
      ],
      active_items: [],
    }
    expect(() => deriveDevelopmentOverlay(options(ledger))).toThrow(/verification gate evidence_ref/)
  })

  it("rejects a graph_ref outside the static graph", () => {
    const ledger = {
      graph_item_states: [
        { graph_ref: "node:ghost", status: "implemented", issue_ids: ["ISS-A"], evidence_refs: ["x/gate.json:1"] },
      ],
      active_items: [],
    }
    expect(() => deriveDevelopmentOverlay(options(ledger))).toThrow(/unknown graph item/)
  })

  it("rejects a ledger entry referencing an unknown issue", () => {
    const ledger = {
      graph_item_states: [
        { graph_ref: "node:ledger", status: "implemented", issue_ids: ["ISS-Z"], evidence_refs: ["x/gate.json:1"] },
      ],
      active_items: [],
    }
    expect(() => deriveDevelopmentOverlay(options(ledger))).toThrow(/unknown issue/)
  })

  it("rejects an issue/graph_ref membership mismatch", () => {
    const ledger = {
      graph_item_states: [
        { graph_ref: "node:cat", status: "implemented", issue_ids: ["ISS-A"], evidence_refs: ["x/gate.json:1"] },
      ],
      active_items: [],
    }
    expect(() => deriveDevelopmentOverlay(options(ledger))).toThrow(/does not include that graph_ref/)
  })

  it("rejects a duplicate graph_item_state", () => {
    const entry = {
      graph_ref: "node:ledger",
      status: "implemented",
      issue_ids: ["ISS-A"],
      evidence_refs: ["x/gate.json:1"],
    }
    const ledger = { graph_item_states: [entry, { ...entry }], active_items: [] }
    expect(() => deriveDevelopmentOverlay(options(ledger))).toThrow(/duplicate graph_item_state/)
  })

  it("requires an in_progress item to have a matching active heartbeat", () => {
    const ledger = {
      graph_item_states: [
        { graph_ref: "node:ledger", status: "in_progress", issue_ids: ["ISS-A"], evidence_refs: [] },
      ],
      active_items: [],
    }
    expect(() => deriveDevelopmentOverlay(options(ledger))).toThrow(/requires a matching active item heartbeat/)
  })

  it("invokes the injected evidenceRefChecker (strict path) for each evidence_ref", () => {
    const checker = vi.fn()
    const ledger = {
      graph_item_states: [
        {
          graph_ref: "node:ledger",
          status: "verified",
          issue_ids: ["ISS-A"],
          evidence_refs: [".vivicy/development/gates/ISS-A.json:1"],
        },
      ],
      active_items: [],
    }
    deriveDevelopmentOverlay(options(ledger, { evidenceRefChecker: checker }))
    expect(checker).toHaveBeenCalledWith(
      ".vivicy/development/gates/ISS-A.json:1",
      "Progress graph item state node:ledger"
    )
  })

  it("omits the evidenceRefChecker on the tolerant (read) path — no filesystem access", () => {
    const ledger = {
      graph_item_states: [
        {
          graph_ref: "node:ledger",
          status: "verified",
          issue_ids: ["ISS-A"],
          evidence_refs: ["does/not/exist/gate.json:999"],
        },
      ],
      active_items: [],
    }
    const overlay = deriveDevelopmentOverlay(options(ledger))
    expect(overlay.graph_item_states[0].status).toBe("verified")
  })
})
