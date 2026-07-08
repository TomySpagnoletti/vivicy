import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { CrReviewSection } from "@/components/crs/cr-review-section"
import { renderWithIntl } from "@/test/render"

const PENDING_CR = {
  id: "CR-0001",
  title: "Spike gate:phase0:s01-argon2id hypothesis disproven",
  status: "idea",
  classification: "major_product_change",
  created_at: "2026-07-03",
  source: "agent",
}

function mockFetch(handlers: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`
    const body = handlers[key] ?? handlers[url] ?? { ok: true }
    return { ok: true, status: 200, json: async () => body } as Response
  })
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch({ "/api/control/crs": { ok: true, crs: [PENDING_CR] } }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("CrReviewSection", () => {
  test("renders a pending CR with Approve and Reject", async () => {
    renderWithIntl(<CrReviewSection />)
    expect(await screen.findByText(/awaiting your decision/i)).toBeInTheDocument()
    expect(screen.getByText("CR-0001")).toBeInTheDocument()
    expect(screen.getByText(/hypothesis disproven/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Approve$/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Reject$/ })).toBeInTheDocument()
  })

  test("renders nothing when there is no pending CR", async () => {
    vi.stubGlobal("fetch", mockFetch({ "/api/control/crs": { ok: true, crs: [] } }))
    const { container } = renderWithIntl(<CrReviewSection />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  test("approving POSTs the decision only after the confirm dialog", async () => {
    const fetchSpy = mockFetch({
      "/api/control/crs": { ok: true, crs: [PENDING_CR] },
      "POST /api/control/crs/decide": { ok: true, summary: "applied" },
    })
    vi.stubGlobal("fetch", fetchSpy)
    const user = userEvent.setup()
    renderWithIntl(<CrReviewSection />)

    await user.click(await screen.findByRole("button", { name: /^Approve$/ }))
    // The decision must NOT fire until the confirm dialog is accepted (sensitive action).
    expect(fetchSpy).not.toHaveBeenCalledWith(
      "/api/control/crs/decide",
      expect.objectContaining({ method: "POST" })
    )
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: /^Approve$/ }))

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/control/crs/decide",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ id: "CR-0001", decision: "approved" }),
        })
      )
    )
  })
})
