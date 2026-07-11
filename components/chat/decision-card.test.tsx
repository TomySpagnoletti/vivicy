import { fireEvent, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"

import type { ViviCard } from "@/lib/vivi"
import { DecisionCard } from "@/components/chat/decision-card"
import { renderWithIntl } from "@/test/render"

const SESSION = "33333333-3333-3333-3333-333333333333"

const IMPORT_CARD: ViviCard = {
  id: "welcome-import-docs",
  title: "Already wrote some of this down?",
  body: "Hand your docs over now.",
  actions: [{ id: "import", label: "I have docs to import", action: { kind: "import_docs" } }],
}

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

    expect(
      await screen.findByText("Chose “Approve” — CR-0001 approved")
    ).toBeInTheDocument()
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

describe("DecisionCard — import_docs (native file picker)", () => {
  function fileInput(): HTMLInputElement {
    return document.querySelector('input[type="file"]') as HTMLInputElement
  }

  test("offers a hidden multi-file picker accepting documents and .zip, not a drop zone", () => {
    vi.stubGlobal("fetch", vi.fn())
    renderWithIntl(<DecisionCard sessionId={SESSION} card={IMPORT_CARD} />)

    const input = fileInput()
    expect(input).toHaveAttribute("multiple")
    expect(input.accept).toContain(".md")
    expect(input.accept).toContain(".zip")
    expect(input).toHaveClass("hidden")
    expect(screen.getByRole("button", { name: "I have docs to import" })).toBeEnabled()
  })

  test("choosing files uploads a multipart batch, decides the card, and re-syncs", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      jsonResponse({
        ok: true,
        summary: "2 documents imported · English",
        decided: { actionId: "import", at: "2026-07-11T10:00:00Z", summary: "2 documents imported · English" },
      })
    )
    vi.stubGlobal("fetch", fetchMock)
    const onDecided = vi.fn()
    const user = userEvent.setup()
    renderWithIntl(<DecisionCard sessionId={SESSION} card={IMPORT_CARD} onDecided={onDecided} />)

    await user.click(screen.getByRole("button", { name: "I have docs to import" }))
    await user.upload(fileInput(), [
      new File(["# brief"], "brief.md", { type: "text/markdown" }),
      new File(["a,b"], "data.csv", { type: "text/csv" }),
    ])

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/vivi/card/import")
    expect(init?.method).toBe("POST")
    const form = init?.body as FormData
    expect(form.get("sessionId")).toBe(SESSION)
    expect(form.get("cardId")).toBe("welcome-import-docs")
    expect(form.get("actionId")).toBe("import")
    expect(form.getAll("files")).toHaveLength(2)
    expect(form.getAll("paths")).toEqual(["brief.md", "data.csv"])

    expect(
      await screen.findByText("Chose “I have docs to import” — 2 documents imported · English")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "I have docs to import" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    expect(onDecided).toHaveBeenCalledWith(IMPORT_CARD.actions[0])
  })

  test("cancelling the picker (no files) leaves the card undecided — no upload", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const onDecided = vi.fn()
    renderWithIntl(<DecisionCard sessionId={SESSION} card={IMPORT_CARD} onDecided={onDecided} />)

    fireEvent.change(fileInput(), { target: { files: [] } })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(onDecided).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "I have docs to import" })).toBeEnabled()
  })

  test("a server-refused upload surfaces the error and keeps the picker live for a retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { ok: false, error: "this folder is not governed by Vivicy", code: "not_governed" },
          409
        )
      )
    )
    const onDecided = vi.fn()
    const user = userEvent.setup()
    renderWithIntl(<DecisionCard sessionId={SESSION} card={IMPORT_CARD} onDecided={onDecided} />)

    await user.click(screen.getByRole("button", { name: "I have docs to import" }))
    await user.upload(fileInput(), [new File(["# brief"], "brief.md", { type: "text/markdown" })])

    expect(
      await screen.findByText("this folder is not governed by Vivicy")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "I have docs to import" })).toBeEnabled()
    expect(onDecided).not.toHaveBeenCalled()
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
