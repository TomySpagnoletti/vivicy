import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { toast } from "sonner"

import { StartGovernanceForm } from "@/components/project/start-governance-form"
import { renderWithIntl } from "@/test/render"

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}))

const LISTING = {
  ok: true,
  path: "/home/dev/target",
  parent: "/home/dev",
  crumbs: [
    { label: "/", path: "/" },
    { label: "home", path: "/home" },
    { label: "dev", path: "/home/dev" },
    { label: "target", path: "/home/dev/target" },
  ],
  entries: [],
}

const PROJECT = { root: "/home/dev/target", name: "target", hasCanonicalSpec: false }

function stubFetch(governResponse?: { body: unknown; status?: number }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    void init

    if (url.includes("/api/fs/list")) return json(LISTING)
    if (url.includes("/api/project/govern")) {
      const r = governResponse ?? { body: { ok: true, project: PROJECT, mode: "from_scratch", batch: null } }
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

beforeEach(() => {
  vi.mocked(toast.error).mockReset()
  vi.mocked(toast.success).mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("StartGovernanceForm — one flow, docs optional", () => {
  test("govern-only: the browsed folder governs with zero docs and reports the project up", async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal("fetch", fetchMock)
    const onGoverned = vi.fn()
    const user = userEvent.setup()
    renderWithIntl(<StartGovernanceForm active onGoverned={onGoverned} />)

    const submit = screen.getByRole("button", { name: "Start governance" })
    await waitFor(() => expect(submit).toBeEnabled())
    await user.click(submit)

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/project/govern") && (c[1] as RequestInit | undefined)?.method === "POST"
      )
      expect(post).toBeDefined()
      const form = (post?.[1] as RequestInit).body as FormData
      expect(form.get("targetDir")).toBe("/home/dev/target")
      expect(form.get("projectName")).toBeNull()
      expect(form.getAll("files")).toEqual([])
    })
    await waitFor(() => expect(onGoverned).toHaveBeenCalledWith(PROJECT))
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "Governance laid",
      expect.objectContaining({
        description: "Your project is ready at /home/dev/target. Talk to Vivi to get grilled.",
      })
    )
  })

  test("with docs: the CTA reflects the count, files are uploaded, and the imported toast names the language", async () => {
    const fetchMock = stubFetch({
      body: {
        ok: true,
        project: PROJECT,
        mode: "from_scratch",
        batch: { batchId: "b", language: "fra", accepted: [{ path: "spec.md" }], rejected: [] },
      },
    })
    vi.stubGlobal("fetch", fetchMock)
    const onGoverned = vi.fn()
    const user = userEvent.setup()
    const { container } = renderWithIntl(<StartGovernanceForm active onGoverned={onGoverned} />)

    await user.upload(fileInput(container), md())

    const submit = await screen.findByRole("button", { name: /Govern & import 1 document/ })
    await waitFor(() => expect(submit).toBeEnabled())
    await user.click(submit)

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/project/govern") && (c[1] as RequestInit | undefined)?.method === "POST"
      )
      const form = (post?.[1] as RequestInit).body as FormData
      expect(form.getAll("files")).toHaveLength(1)
      expect(form.getAll("paths")).toEqual(["spec.md"])
    })
    await waitFor(() => expect(onGoverned).toHaveBeenCalledWith(PROJECT))
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "Governance laid — docs in the kitchen",
      expect.objectContaining({ description: "1 document imported. Detected French." })
    )
  })

  test("an explicit project name is forwarded verbatim", async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderWithIntl(<StartGovernanceForm active onGoverned={vi.fn()} />)

    await user.type(screen.getByLabelText(/Project name/), "Billing API")
    const submit = screen.getByRole("button", { name: "Start governance" })
    await waitFor(() => expect(submit).toBeEnabled())
    await user.click(submit)

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/project/govern") && (c[1] as RequestInit | undefined)?.method === "POST"
      )
      const form = (post?.[1] as RequestInit).body as FormData
      expect(form.get("projectName")).toBe("Billing API")
    })
  })

  test("an already-governed refusal keeps the screen and never reports up", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        status: 409,
        body: { ok: false, error: "already governed", code: "already_governed" },
      })
    )
    const onGoverned = vi.fn()
    const user = userEvent.setup()
    renderWithIntl(<StartGovernanceForm active onGoverned={onGoverned} />)

    const submit = screen.getByRole("button", { name: "Start governance" })
    await waitFor(() => expect(submit).toBeEnabled())
    await user.click(submit)

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Cannot start governance",
        expect.objectContaining({
          description: "This folder is already governed by Vivicy — importing here would overwrite it.",
        })
      )
    )
    expect(onGoverned).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Start governance" })).toBeInTheDocument()
  })

  test("the project-name placeholder previews the browsed folder basename", async () => {
    vi.stubGlobal("fetch", stubFetch())
    renderWithIntl(<StartGovernanceForm active onGoverned={vi.fn()} />)

    await waitFor(() => expect(screen.getByLabelText(/Project name/)).toHaveAttribute("placeholder", "target"))
  })
})
