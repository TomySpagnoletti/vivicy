import { screen, within } from "@testing-library/react"
import { describe, expect, test } from "vitest"

import type { SelectedItem } from "@/components/map/architecture-map"
import { SectionDetails } from "@/components/sidebar/section-details"
import { TranscriptProvider } from "@/components/transcript/transcript-modal"
import type { ArchitectureMapData, MapEdge, MapNode } from "@/lib/types"
import { renderWithIntl } from "@/test/render"

const NODE: MapNode = {
  id: "telegram-channel",
  label: "Telegram Channel",
  kind: "channel",
  lane: "edge",
  scope: "mvp",
  tech: "Telegram Bot API",
  owns_data: ["chat_id", "claim_token"],
  source_refs: [".vivicy/canonical/09-telegram-channel-interface.md:12"],
  layout_x: 0,
  layout_y: 0,
  graph_ref: "node:telegram-channel",
}

const EDGE: MapEdge = {
  from: "telegram-channel",
  to: "worker-platform-mcp",
  relation: "invokes",
  protocol: "Worker Platform MCP",
  data: ["message", "claim_token"],
  source_refs: [".vivicy/canonical/22-worker-platform-mcp.md:8"],
  graph_ref: "edge:telegram->mcp",
}

const NODE_TRANSCRIPT = ".vivicy/development/transcripts/ISSUES/ISSUE-0100/codex-reviewer-b91c05e7-2d4a-4f36-8c17-6e0b93a5d281.jsonl"
const NODE_TRANSCRIPT_NAME = "codex-reviewer-b91c05e7-2d4a-4f36-8c17-6e0b93a5d281.jsonl"

const DATA: ArchitectureMapData = {
  name: "demo-map",
  nodes: [NODE],
  edges: [EDGE],
  development: {
    proofs: [
      {
        issue_id: "ISSUE-0100",
        proofs: [
          {
            id: "claim-flow-screens",
            class: "ui_flow",
            evidences: [".vivicy/canonical/09-telegram-channel-interface.md:12"],
            path: ".vivicy/development/proofs/ISSUE-0100/claim-flow-screens",
            produced: true,
            recipe: true,
            artifacts: ["desktop.png", "mobile.png", "recipe.txt"],
          },
          {
            id: "claim-token-request",
            class: "http_transcript",
            evidences: [".vivicy/canonical/09-telegram-channel-interface.md:20-24"],
            path: ".vivicy/development/proofs/ISSUE-0100/claim-token-request",
            produced: false,
            recipe: false,
            artifacts: [],
          },
        ],
      },
      {
        issue_id: "ISSUE-0200",
        proofs: [
          {
            id: "mcp-invocation",
            class: "gate_evidence",
            evidences: [".vivicy/canonical/22-worker-platform-mcp.md:8"],
            path: ".vivicy/development/gates/ISSUE-0200-gate.json",
            produced: true,
            recipe: true,
            artifacts: ["ISSUE-0200-gate.json"],
          },
        ],
      },
    ],
    issues: [
      { id: "ISSUE-0100", title: "Wire the channel", graph_refs: ["node:telegram-channel"] },
      { id: "ISSUE-0200", title: "Wire the protocol", graph_refs: ["edge:telegram->mcp"] },
    ],
    graph_item_states: [
      {
        graph_ref: "node:telegram-channel",
        status: "implemented",
        evidence_refs: [".vivicy/development/gates/ISSUE-0100-gate.json"],
        transcript_refs: [NODE_TRANSCRIPT],
      },
      {
        graph_ref: "edge:telegram->mcp",
        status: "in_progress",
        transcript_refs: [
          ".vivicy/development/transcripts/ISSUES/ISSUE-0200/claude-implementer-4d7f2a91-6c3b-4e58-9a02-1f8e5b7c3d64.jsonl",
        ],
      },
    ],
  },
}

function renderDetails(selected: SelectedItem, data: ArchitectureMapData = DATA) {
  return renderWithIntl(
    <TranscriptProvider>
      <SectionDetails selected={selected} data={data} />
    </TranscriptProvider>
  )
}

describe("SectionDetails — nothing selected", () => {
  test("renders the none-selected guidance", () => {
    renderDetails(null)
    expect(screen.getByText(/Select a node or an edge to inspect protocol/)).toBeInTheDocument()
  })
})

describe("SectionDetails — a selected node", () => {
  test("renders the label, kind, status, the map's source refs, and the LEDGER's evidence refs", () => {
    renderDetails({ type: "node", item: NODE })

    expect(screen.getByText("Telegram Channel")).toBeInTheDocument()
    expect(screen.getByText("channel")).toBeInTheDocument()
    expect(screen.getByText("Telegram Bot API")).toBeInTheDocument()
    expect(screen.getByText("chat_id, claim_token")).toBeInTheDocument()
    expect(screen.getByText("implemented")).toBeInTheDocument()

    const sourceLabel = screen.getByText("Source refs")
    const sourceGroup = sourceLabel.parentElement as HTMLElement
    expect(within(sourceGroup).getByText(".vivicy/canonical/09-telegram-channel-interface.md:12")).toBeInTheDocument()
    expect(screen.getByText("Evidence refs")).toBeInTheDocument()
    expect(screen.getByText(".vivicy/development/gates/ISSUE-0100-gate.json")).toBeInTheDocument()
  })

  test("lists the covering issue and the captured transcript button", () => {
    renderDetails({ type: "node", item: NODE })
    expect(screen.getByText("Covered by")).toBeInTheDocument()
    expect(screen.getByText("ISSUE-0100")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: NODE_TRANSCRIPT_NAME })).toBeInTheDocument()
  })

  test("lists the declared proofs of its covering issues — class, produced state, canonical refs, and where they sit on disk", () => {
    renderDetails({ type: "node", item: NODE })

    expect(screen.getByText("Proofs")).toBeInTheDocument()
    expect(screen.getByText("claim-flow-screens")).toBeInTheDocument()
    expect(screen.getByText("ui flow")).toBeInTheDocument()
    expect(screen.getByText("ISSUE-0100 · produced")).toBeInTheDocument()

    expect(screen.getByText("claim-token-request")).toBeInTheDocument()
    expect(screen.getByText("http transcript")).toBeInTheDocument()
    expect(screen.getByText("ISSUE-0100 · not produced yet"), "an owed-but-absent observation is visible, never hidden").toBeInTheDocument()

    const produced = screen.getByText("claim-flow-screens").closest("li") as HTMLElement
    expect(within(produced).getByText(/\.vivicy\/canonical\/09-telegram-channel-interface\.md:12/)).toBeInTheDocument()
    expect(within(produced).getByText(/\.vivicy\/development\/proofs\/ISSUE-0100\/claim-flow-screens/)).toBeInTheDocument()
    expect(within(produced).getByText("Evidences")).toBeInTheDocument()
    expect(within(produced).getByText("On disk")).toBeInTheDocument()
  })

  test("falls back to the node's own status when no overlay state exists", () => {
    const lonelyNode: MapNode = { ...NODE, id: "lonely", graph_ref: "node:lonely", status: "blocked" }
    renderDetails({ type: "node", item: lonelyNode }, { name: "m", nodes: [lonelyNode], edges: [] })
    expect(screen.getByText("blocked")).toBeInTheDocument()
    expect(screen.getByText("None yet")).toBeInTheDocument()
    expect(screen.queryByText("Proofs"), "a node no issue covers shows no proofs block at all").toBeNull()
  })
})

describe("SectionDetails — transcript buttons", () => {
  test("the button takes its width from the box, never from its label, and keeps the run id at the tail", () => {
    renderDetails({ type: "node", item: NODE })
    const button = screen.getByRole("button", { name: NODE_TRANSCRIPT_NAME })

    expect(button, "the full ref stays reachable without opening it").toHaveAttribute("title", NODE_TRANSCRIPT)
    expect(button, "the box sizes the button, never the 57-character label").toHaveClass("w-full")
    expect(button, "no label can paint past the button's own edge").toHaveClass("overflow-hidden")

    const [head, tail] = Array.from(button.children)
    expect(head, "the head is the part that gives way").toHaveClass("truncate")
    expect(tail, "the run id at the tail is never the part that gives way").toHaveClass("shrink-0")
    expect(tail).toHaveTextContent("a5d281.jsonl")
    expect(`${head.textContent}${tail.textContent}`, "truncation is visual only — the label itself loses nothing").toBe(
      NODE_TRANSCRIPT_NAME
    )
  })

  test("a state with no transcripts renders no Transcripts block at all", () => {
    const quiet: MapNode = { ...NODE, id: "quiet", graph_ref: "node:quiet" }
    renderDetails(
      { type: "node", item: quiet },
      {
        name: "m",
        nodes: [quiet],
        edges: [],
        development: {
          graph_item_states: [{ graph_ref: "node:quiet", status: "implemented", transcript_refs: [] }],
        },
      }
    )
    expect(screen.queryByText("Transcripts")).toBeNull()
  })
})

describe("SectionDetails — a selected edge", () => {
  test("renders the endpoints, protocol, relation, and progress status", () => {
    renderDetails({ type: "edge", id: "edge:telegram->mcp", item: EDGE })

    expect(screen.getByText("telegram-channel → worker-platform-mcp")).toBeInTheDocument()
    expect(screen.getByText("Worker Platform MCP")).toBeInTheDocument()
    expect(screen.getByText("invokes")).toBeInTheDocument()
    expect(screen.getByText("message, claim_token")).toBeInTheDocument()
    expect(screen.getByText("in progress")).toBeInTheDocument()
    expect(screen.getByText("ISSUE-0200")).toBeInTheDocument()
  })

  test("reaches the proofs of the issues covering the edge, gate-witnessed ones included", () => {
    renderDetails({ type: "edge", id: "edge:telegram->mcp", item: EDGE })

    expect(screen.getByText("Proofs")).toBeInTheDocument()
    expect(screen.getByText("mcp-invocation")).toBeInTheDocument()
    expect(screen.getByText("gate evidence")).toBeInTheDocument()
    expect(screen.getByText("ISSUE-0200 · produced")).toBeInTheDocument()
    expect(
      screen.getByText(/\.vivicy\/development\/gates\/ISSUE-0200-gate\.json/),
      "a gate-witnessed proof points at the gate record itself, no ritual artifact"
    ).toBeInTheDocument()
    expect(screen.queryByText("claim-flow-screens"), "another item's proofs never leak in").toBeNull()
  })
})
