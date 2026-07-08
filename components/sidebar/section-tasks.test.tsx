import { screen, within } from "@testing-library/react"
import { describe, expect, test } from "vitest"

import { SectionTasks } from "@/components/sidebar/section-tasks"
import { TranscriptProvider } from "@/components/transcript/transcript-modal"
import type { DevelopmentBlock } from "@/lib/types"
import { renderWithIntl } from "@/test/render"

/** SectionTasks renders TranscriptRefs, which needs the transcript context. */
function renderTasks(development: DevelopmentBlock | undefined) {
  return renderWithIntl(
    <TranscriptProvider>
      <SectionTasks development={development} />
    </TranscriptProvider>
  )
}

describe("SectionTasks — empty state", () => {
  test("an empty development block renders the no-issues guidance", () => {
    renderTasks({ issues: [] })
    expect(screen.getByText(/No generated issues yet/)).toBeInTheDocument()
    // The three-metric header still renders with a zero Issues count.
    expect(screen.getByText("Issues")).toBeInTheDocument()
  })

  test("an undefined development block is treated as empty", () => {
    renderTasks(undefined)
    expect(screen.getByText(/No generated issues yet/)).toBeInTheDocument()
  })
})

describe("SectionTasks — issue cards", () => {
  test("a card shows the issue id, path, title and a humanized status badge", () => {
    const development: DevelopmentBlock = {
      issues: [
        {
          id: "ISS-0001",
          title: "Bootstrap the workspace",
          issue_path: ".vivicy/development/issues/ISS-0001.md",
          graph_refs: ["node:app"],
          requirement_ids: ["REQ-1", "REQ-2"],
        },
      ],
      // One graph item still in progress => issueDisplayStatus -> "in_progress".
      graph_item_states: [{ graph_ref: "node:app", status: "in_progress" }],
    }
    renderTasks(development)

    const card = screen.getByText("ISS-0001").closest("li") as HTMLElement
    expect(card).toBeTruthy()
    expect(within(card).getByText("Bootstrap the workspace")).toBeInTheDocument()
    expect(
      within(card).getByText(".vivicy/development/issues/ISS-0001.md")
    ).toBeInTheDocument()
    // The status is humanized (underscores -> spaces) into a badge.
    expect(within(card).getByText("in progress")).toBeInTheDocument()
    // The requirement refs render; missing ref groups read "None".
    expect(within(card).getByText("REQ-1, REQ-2")).toBeInTheDocument()
  })

  test("a fully-verified issue surfaces the 'verified' status affordance", () => {
    const development: DevelopmentBlock = {
      issues: [{ id: "ISS-0002", title: "Done work", graph_refs: ["node:x", "node:y"] }],
      // Every graph item verified => aggregate display status is "verified".
      graph_item_states: [
        { graph_ref: "node:x", status: "verified" },
        { graph_ref: "node:y", status: "verified" },
      ],
    }
    renderTasks(development)
    const card = screen.getByText("ISS-0002").closest("li") as HTMLElement
    expect(within(card).getByText("verified")).toBeInTheDocument()
  })

  test("an active issue gets the highlighted border and Active count", () => {
    const development: DevelopmentBlock = {
      issues: [{ id: "ISS-0003", title: "In flight", graph_refs: ["node:z"] }],
      active_items: [{ id: "ai-1", issue_id: "ISS-0003", state: "reviewing" }],
    }
    renderTasks(development)
    const card = screen.getByText("ISS-0003").closest("li") as HTMLElement
    // Active items drive a verified-toned border on the card.
    expect(card).toHaveClass("border-status-verified")
    // The active item's live state wins as the displayed status.
    expect(within(card).getByText("reviewing")).toBeInTheDocument()
  })

  test("a transcript ref under the issue renders a clickable transcript button", () => {
    const development: DevelopmentBlock = {
      issues: [{ id: "ISS-0004", title: "Has transcript", graph_refs: ["node:t"] }],
      graph_item_states: [
        {
          graph_ref: "node:t",
          status: "implemented",
          // Path encodes the issue id, so issueTranscriptRefs keeps it.
          transcript_refs: ["runs/transcripts/ISS-0004/claude-session.jsonl"],
        },
      ],
    }
    renderTasks(development)
    const card = screen.getByText("ISS-0004").closest("li") as HTMLElement
    expect(within(card).getByText("Transcripts")).toBeInTheDocument()
    // The transcript button shows the file name and is a real button.
    const btn = within(card).getByRole("button", { name: "claude-session.jsonl" })
    expect(btn).toBeInTheDocument()
  })

  test("an issue with no matching transcript renders no transcript section", () => {
    const development: DevelopmentBlock = {
      issues: [{ id: "ISS-0005", title: "No transcript", graph_refs: ["node:n"] }],
      graph_item_states: [
        {
          graph_ref: "node:n",
          status: "in_progress",
          // Belongs to a DIFFERENT issue id, so it is filtered out here.
          transcript_refs: ["runs/transcripts/ISS-9999/other.jsonl"],
        },
      ],
    }
    renderTasks(development)
    const card = screen.getByText("ISS-0005").closest("li") as HTMLElement
    expect(within(card).queryByText("Transcripts")).not.toBeInTheDocument()
  })

  test("the coverage summary renders the doc-line counters when present", () => {
    const development: DevelopmentBlock = {
      issues: [{ id: "ISS-0006", title: "Covered", graph_refs: [] }],
      coverage_summary: {
        total_doc_lines: 200,
        classified_doc_lines: 150,
        requirement_linked_doc_lines: 120,
        issue_linked_doc_lines: 100,
      },
    }
    renderTasks(development)
    expect(screen.getByText("Doc lines")).toBeInTheDocument()
    // issue_linked / total => 100/200 => 50.0% in the header metric.
    expect(screen.getByText("50.0%")).toBeInTheDocument()
    // Classified is shown as a "value / of" pair.
    expect(screen.getByText("150 / 200")).toBeInTheDocument()
  })
})
