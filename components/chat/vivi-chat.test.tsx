import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ViviChat } from "@/components/chat/vivi-chat"
import { renderWithIntl } from "@/test/render"

/**
 * Happy-path render + one round-trip. `fetch` is stubbed: GET returns the read-only
 * engine, POST echoes a Vivi reply with a written file. Asserts the engine badge,
 * the user + Vivi bubbles, and the "wrote" chip — no real network, no agent.
 */
describe("ViviChat", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (!init || init.method !== "POST") {
          return jsonResponse({
            ok: true,
            engine: { provider: "claude", providerLabel: "Claude Code", model: "claude-opus-4-8" },
          })
        }
        return jsonResponse({
          ok: true,
          sessionId: "11111111-1111-1111-1111-111111111111",
          reply: "What states can a todo be in?",
          wrote: [".vivicy/canonical/01-product.md"],
        })
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("renders the panel with the read-only engine badge", async () => {
    renderWithIntl(<ViviChat open onOpenChange={vi.fn()} />)
    expect(screen.getByText("Build the spec with Vivi")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByText(/Claude Code · claude-opus-4-8/)).toBeInTheDocument()
    )
  })

  test("sending a message shows the user bubble, Vivi's reply, and the wrote chip", async () => {
    const user = userEvent.setup()
    const onWrote = vi.fn()
    renderWithIntl(<ViviChat open onOpenChange={vi.fn()} onWrote={onWrote} />)

    await user.type(screen.getByLabelText("Message Vivi"), "I want a todo app.")
    await user.click(screen.getByRole("button", { name: "Send message" }))

    expect(await screen.findByText("I want a todo app.")).toBeInTheDocument()
    expect(await screen.findByText("What states can a todo be in?")).toBeInTheDocument()
    // The wrote chip carries the written path...
    expect(await screen.findByText(".vivicy/canonical/01-product.md")).toBeInTheDocument()
    // ...and the caller is told a file landed.
    await waitFor(() =>
      expect(onWrote).toHaveBeenCalledWith([".vivicy/canonical/01-product.md"])
    )
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
