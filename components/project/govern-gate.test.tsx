import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { toast } from "sonner"

import type { BoundProject } from "@/lib/project-types"
import { GovernGate } from "@/components/project/govern-gate"
import { renderWithIntl } from "@/test/render"

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}))

const BOUND: BoundProject = { root: "/home/dev/target", name: "target", governed: false }
const GOVERNED: BoundProject = { root: "/home/dev/target", name: "target", governed: true }

const reload = vi.fn()

function stubFetch(governResponse?: { body: unknown; status?: number }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    void init

    if (url.includes("/api/project/govern")) {
      const r = governResponse ?? { body: { ok: true, project: GOVERNED, mode: "from_scratch", batch: null } }
      return json(r.body, r.status)
    }
    return json({ ok: true })
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]')
  if (!input) throw new Error("file input not found")
  return input as HTMLInputElement
}

const md = (name = "spec.md") => new File(["# Product spec\nHello."], name, { type: "text/markdown" })

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.mocked(toast.error).mockReset()
  vi.mocked(toast.success).mockReset()
  reload.mockReset()
  Object.defineProperty(window, "location", { configurable: true, value: { reload } })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GovernGate — the bound folder governs itself, docs optional", () => {
  test("govern-only: it posts NO folder (the binding is the folder) and reloads into the workspace", async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderWithIntl(<GovernGate project={BOUND} />)

    expect(screen.getByText("/home/dev/target")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Start governance" }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/project/govern") && (c[1] as RequestInit | undefined)?.method === "POST"
      )
      expect(post).toBeDefined()
      const form = (post?.[1] as RequestInit).body as FormData
      expect(form.get("targetDir"), "the folder is the server's binding, never a field the browser can choose").toBeNull()
      expect(form.get("projectName")).toBeNull()
      expect(form.getAll("files")).toEqual([])
    })
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "Governance laid",
      expect.objectContaining({ description: "Your project is ready. Talk to Vivi to get grilled." })
    )
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  test("with docs: the CTA reflects the count, files are uploaded, and the imported toast names the language", async () => {
    const fetchMock = stubFetch({
      body: {
        ok: true,
        project: GOVERNED,
        mode: "from_scratch",
        batch: { batchId: "b", language: "fra", accepted: [{ path: "spec.md" }], rejected: [] },
      },
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    const { container } = renderWithIntl(<GovernGate project={BOUND} />)

    await user.upload(fileInput(container), md())

    await user.click(await screen.findByRole("button", { name: /Govern & import 1 document/ }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/project/govern") && (c[1] as RequestInit | undefined)?.method === "POST"
      )
      const form = (post?.[1] as RequestInit).body as FormData
      expect(form.getAll("files")).toHaveLength(1)
      expect(form.getAll("paths")).toEqual(["spec.md"])
    })
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "Governance laid — docs in the kitchen",
      expect.objectContaining({ description: "1 document imported. Detected French." })
    )
  })

  test("an explicit project name is forwarded verbatim", async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderWithIntl(<GovernGate project={BOUND} />)

    await user.type(screen.getByLabelText(/Project name/), "Billing API")
    await user.click(screen.getByRole("button", { name: "Start governance" }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/project/govern") && (c[1] as RequestInit | undefined)?.method === "POST"
      )
      const form = (post?.[1] as RequestInit).body as FormData
      expect(form.get("projectName")).toBe("Billing API")
    })
  })

  test("an already-governed refusal keeps the screen, reloads nothing, and re-arms the button", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        status: 409,
        body: { ok: false, error: "already governed", code: "already_governed" },
      })
    )
    const user = userEvent.setup()
    renderWithIntl(<GovernGate project={BOUND} />)

    await user.click(screen.getByRole("button", { name: "Start governance" }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Cannot start governance",
        expect.objectContaining({
          description: "This folder is already governed by Vivicy — importing here would overwrite it.",
        })
      )
    )
    expect(reload).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole("button", { name: "Start governance" })).toHaveAttribute("aria-disabled", "false"))
  })

  test("the in-flight CTA stays in the a11y tree as aria-disabled and fires exactly one govern POST", async () => {
    const gate = deferred()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/project/govern")) {
        await gate.promise
        return json({ ok: true, project: GOVERNED, mode: "from_scratch", batch: null })
      }
      return json({ ok: true })
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderWithIntl(<GovernGate project={BOUND} />)

    const submit = screen.getByRole("button", { name: "Start governance" })
    await user.click(submit)

    const inFlight = screen.getByRole("button", { name: "Laying governance…" })
    expect(inFlight, "never the native disabled attribute — it drops keyboard focus to <body>").not.toHaveAttribute("disabled")
    expect(inFlight).toHaveAttribute("aria-disabled", "true")
    await user.click(inFlight)

    gate.resolve()
    await waitFor(() => expect(reload).toHaveBeenCalled())
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/project/govern"))).toHaveLength(1)
  })

  test("the project-name placeholder previews the bound folder's basename", () => {
    vi.stubGlobal("fetch", stubFetch())
    renderWithIntl(<GovernGate project={BOUND} />)

    expect(screen.getByLabelText(/Project name/)).toHaveAttribute("placeholder", "target")
  })
})
