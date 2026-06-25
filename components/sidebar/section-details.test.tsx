import { render, screen, within } from "@testing-library/react"
import { describe, expect, test } from "vitest"

import type { SelectedItem } from "@/components/map/architecture-map"
import { SectionDetails } from "@/components/sidebar/section-details"
import { TranscriptProvider } from "@/components/transcript/transcript-modal"
import type { ArchitectureMapData, MapEdge, MapNode } from "@/lib/types"

const NODE: MapNode = {
  id: "telegram-channel",
  label: "Telegram Channel",
  kind: "channel",
  lane: "edge",
  scope: "mvp",
  tech: "Telegram Bot API",
  owns_data: ["chat_id", "claim_token"],
  source_refs: ["docs/canonical/09-telegram-channel-interface.md:12"],
  evidence_refs: ["spikes/telegram.md:3"],
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
  source_refs: ["docs/canonical/22-worker-platform-mcp.md:8"],
  graph_ref: "edge:telegram->mcp",
}

/** A map whose development block covers both the node and the edge graph refs. */
const DATA: ArchitectureMapData = {
  name: "demo-map",
  nodes: [NODE],
  edges: [EDGE],
  development: {
    issues: [
      { id: "ISS-0100", title: "Wire the channel", graph_refs: ["node:telegram-channel"] },
      { id: "ISS-0200", title: "Wire the protocol", graph_refs: ["edge:telegram->mcp"] },
    ],
    graph_item_states: [
      {
        graph_ref: "node:telegram-channel",
        status: "implemented",
        transcript_refs: ["runs/transcripts/ISS-0100/codex-rollout.jsonl"],
      },
      {
        graph_ref: "edge:telegram->mcp",
        status: "in_progress",
        transcript_refs: ["runs/transcripts/ISS-0200/claude.jsonl"],
      },
    ],
  },
}

function renderDetails(selected: SelectedItem, data: ArchitectureMapData = DATA) {
  return render(
    <TranscriptProvider>
      <SectionDetails selected={selected} data={data} />
    </TranscriptProvider>
  )
}

describe("SectionDetails — nothing selected", () => {
  test("renders the none-selected guidance", () => {
    renderDetails(null)
    expect(
      screen.getByText(/Select a node or an edge to inspect protocol/)
    ).toBeInTheDocument()
  })
})

describe("SectionDetails — a selected node", () => {
  test("renders the label, kind, status, and source/evidence refs", () => {
    renderDetails({ type: "node", item: NODE })

    expect(screen.getByText("Telegram Channel")).toBeInTheDocument()
    // Field rows: kind, lane, scope, tech, owns_data all render their values.
    expect(screen.getByText("channel")).toBeInTheDocument()
    expect(screen.getByText("Telegram Bot API")).toBeInTheDocument()
    expect(screen.getByText("chat_id, claim_token")).toBeInTheDocument()
    // The overlay status (implemented) is shown, humanized.
    expect(screen.getByText("implemented")).toBeInTheDocument()

    // Source + evidence refs render as labelled badge groups.
    const sourceLabel = screen.getByText("Source refs")
    const sourceGroup = sourceLabel.parentElement as HTMLElement
    expect(
      within(sourceGroup).getByText("docs/canonical/09-telegram-channel-interface.md:12")
    ).toBeInTheDocument()
    expect(screen.getByText("Evidence refs")).toBeInTheDocument()
    expect(screen.getByText("spikes/telegram.md:3")).toBeInTheDocument()
  })

  test("lists the covering issue and the captured transcript button", () => {
    renderDetails({ type: "node", item: NODE })
    // The issue whose graph_refs include this node's ref is listed under Covered by.
    expect(screen.getByText("Covered by")).toBeInTheDocument()
    expect(screen.getByText("ISS-0100")).toBeInTheDocument()
    // Its transcript state ref becomes a clickable transcript button.
    expect(
      screen.getByRole("button", { name: "codex-rollout.jsonl" })
    ).toBeInTheDocument()
  })

  test("falls back to the node's own status when no overlay state exists", () => {
    const lonelyNode: MapNode = { ...NODE, id: "lonely", graph_ref: "node:lonely", status: "blocked" }
    renderDetails(
      { type: "node", item: lonelyNode },
      { name: "m", nodes: [lonelyNode], edges: [] }
    )
    expect(screen.getByText("blocked")).toBeInTheDocument()
    // No issues / transcripts => "None yet" under Covered by.
    expect(screen.getByText("None yet")).toBeInTheDocument()
  })
})

describe("SectionDetails — a selected edge", () => {
  test("renders the endpoints, protocol, relation, and progress status", () => {
    renderDetails({ type: "edge", id: "edge:telegram->mcp", item: EDGE })

    // Endpoint header.
    expect(screen.getByText("telegram-channel → worker-platform-mcp")).toBeInTheDocument()
    // Protocol + relation + data values render from the edge.
    expect(screen.getByText("Worker Platform MCP")).toBeInTheDocument()
    expect(screen.getByText("invokes")).toBeInTheDocument()
    expect(screen.getByText("message, claim_token")).toBeInTheDocument()
    // The edge's overlay status (in_progress) renders as Progress, humanized.
    expect(screen.getByText("in progress")).toBeInTheDocument()
    // The covering issue is listed.
    expect(screen.getByText("ISS-0200")).toBeInTheDocument()
  })
})
