import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"

import type { ViviCard } from "@/lib/vivi"
import { DecisionCard } from "@/components/chat/decision-card"
import { renderWithIntl } from "@/test/render"

const SESSION = "33333333-3333-3333-3333-333333333333"

const CARD: ViviCard = {
  id: "card-9",
  title: "Approve CR-0001?",
  body: "Switch login to magic links.",
  actions: [
    {
      id: "approve",
      label: "Approve",
      action: { kind: "cr_decide", crId: "CR-0001", decision: "approved" },
    },
    {
      id: "reject",
      label: "Reject",
      variant: "destructive",
      action: { kind: "cr_decide", crId: "CR-0001", decision: "rejected" },
    },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("DecisionCard", () => {
  test("renders the title, body, and one live button per action", () => {
    vi.stubGlobal("fetch", vi.fn())
    renderWithIntl(<DecisionCard sessionId={SESSION} card={CARD} />)

    expect(screen.getByText("Approve CR-0001?")).toBeInTheDocument()
    expect(screen.getByText("Switch login to magic links.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled()
  })

  test("clicking POSTs the exact payload, then disables all buttons forever and shows the summary", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => jsonResponse({ ok: true, summary: "CR-0001 approved" }))
    vi.stubGlobal("fetch", fetchMock)
    const onDecided = vi.fn()
    const user = userEvent.setup()
    renderWithIntl(
      <DecisionCard sessionId={SESSION} card={CARD} onDecided={onDecided} />
    )

    await user.click(screen.getByRole("button", { name: "Approve" }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/vivi/card",
        expect.objectContaining({ method: "POST" })
      )
      const init = fetchMock.mock.calls[0][1]
      expect(JSON.parse(init?.body as string)).toEqual({
        sessionId: SESSION,
        cardId: "card-9",
        actionId: "approve",
      })
    })

    expect(
      await screen.findByText("Chose “Approve” — CR-0001 approved")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("button", { name: "Reject" })).toHaveAttribute("aria-disabled", "true")
    expect(onDecided).toHaveBeenCalledWith(CARD.actions[0])
  })

  test("a turn rehydrated with `decided` renders disabled with the recorded outcome — no fetch", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    renderWithIntl(
      <DecisionCard
        sessionId={SESSION}
        card={CARD}
        decided={{
          actionId: "reject",
          at: "2026-07-08T10:00:00Z",
          summary: "CR-0001 rejected",
        }}
      />
    )

    expect(
      screen.getByText("Chose “Reject” — CR-0001 rejected")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("button", { name: "Reject" })).toHaveAttribute("aria-disabled", "true")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("a 422 carrying `decided` (already-decided / executed-but-failed) locks the buttons and shows both markers", async () => {
    // The extended contract: /api/vivi/card ALWAYS returns `decided` once the card
    // is decided — including an ok:false already-decided or executed-but-failed
    // outcome. The client must render that permanent decision, not offer a re-click.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            ok: false,
            summary:
              "this card was already decided (approve at 2026-07-08T10:00:00Z)",
            decided: {
              actionId: "approve",
              at: "2026-07-08T10:00:00Z",
              summary: "CR-0001 approved",
            },
          },
          422
        )
      )
    )
    const onDecided = vi.fn()
    const user = userEvent.setup()
    renderWithIntl(
      <DecisionCard sessionId={SESSION} card={CARD} onDecided={onDecided} />
    )

    await user.click(screen.getByRole("button", { name: "Approve" }))

    // The decided marker renders from the server stamp, and the buttons stay
    // permanently disabled — the stamp is authoritative.
    expect(
      await screen.findByText("Chose “Approve” — CR-0001 approved")
    ).toBeInTheDocument()
    // The failure is surfaced honestly alongside the decided state.
    expect(
      screen.getByText(/this card was already decided/)
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    expect(screen.getByRole("button", { name: "Reject" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    expect(onDecided).toHaveBeenCalledWith(CARD.actions[0])
  })

  test("a decision-less failure (no `decided`) shows the error and re-enables for a retry", async () => {
    // A genuine validation failure that recorded NOTHING (e.g. an unknown card id)
    // carries no `decided`, so the buttons must re-open for another attempt.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { ok: false, error: "unknown card", code: "missing_target" },
          422
        )
      )
    )
    const onDecided = vi.fn()
    const user = userEvent.setup()
    renderWithIntl(
      <DecisionCard sessionId={SESSION} card={CARD} onDecided={onDecided} />
    )

    await user.click(screen.getByRole("button", { name: "Approve" }))

    expect(await screen.findByText("unknown card")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled()
    expect(onDecided).not.toHaveBeenCalled()
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
