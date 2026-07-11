import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { toast } from "sonner"

import { ImportDocsFlow } from "@/components/project/import-docs-flow"
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

function stubFetch(importResponse?: { body: unknown; status?: number }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("/api/fs/list")) return json(LISTING)
    if (url.includes("/api/project/import")) {
      const r = importResponse ?? { body: { ok: true } }
      return json(r.body, r.status)
    }
    return json({ ok: true })
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]')
  if (!input) throw new Error("file input not found")
  return input as HTMLInputElement
}

const md = (name = "spec.md") => new File(["# Product spec\nHello."], name, { type: "text/markdown" })
const exe = (name = "notes.exe") => new File(["MZ"], name, { type: "application/octet-stream" })

function dropFiles(files: File[]) {
  const dropzone = screen.getByText("Drag files, a folder, or a .zip here").parentElement as HTMLElement
  fireEvent.drop(dropzone, { dataTransfer: { items: [], files, types: ["Files"] } })
}

beforeEach(() => {
  vi.mocked(toast.error).mockReset()
  vi.mocked(toast.success).mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ImportDocsFlow — docs first, folder second", () => {
  test("step 2 is locked and the import CTA disabled until a document is added", async () => {
    vi.stubGlobal("fetch", stubFetch())
    renderWithIntl(<ImportDocsFlow active onImported={vi.fn()} />)

    expect(
      screen.getByText("Add at least one document above to choose where it lands.")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Import documents" })).toBeDisabled()
  })

  test("a single file picker carries the server allowlist including .zip", () => {
    vi.stubGlobal("fetch", stubFetch())
    const { container } = renderWithIntl(<ImportDocsFlow active onImported={vi.fn()} />)

    const inputs = container.querySelectorAll('input[type="file"]')
    expect(inputs).toHaveLength(1)
    const accept = fileInput(container).getAttribute("accept") ?? ""
    expect(accept).toContain(".md")
    expect(accept).toContain(".docx")
    expect(accept).toContain(".zip")
    expect(inputs[0].hasAttribute("webkitdirectory")).toBe(false)
  })

  test("an accepted document unlocks step 2 and the import CTA once a folder is browsed", async () => {
    vi.stubGlobal("fetch", stubFetch())
    const user = userEvent.setup()
    const { container } = renderWithIntl(<ImportDocsFlow active onImported={vi.fn()} />)

    await user.upload(fileInput(container), md())

    expect(await screen.findByText("1 document ready")).toBeInTheDocument()
    expect(screen.getByText(/Vivicy will govern it/)).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import documents" })).toBeEnabled()
    )
  })

  test("a dropped unsupported file is marked skipped; only the supported one satisfies the gate", async () => {
    vi.stubGlobal("fetch", stubFetch())
    renderWithIntl(<ImportDocsFlow active onImported={vi.fn()} />)

    dropFiles([exe()])
    const row = (await screen.findByText("notes.exe")).closest("div") as HTMLElement
    expect(within(row).getByText("unsupported")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Import documents" })).toBeDisabled()

    dropFiles([md(), exe()])
    expect(await screen.findByText("1 document ready", { exact: false })).toBeInTheDocument()
    expect(screen.getByText("1 file skipped", { exact: false })).toBeInTheDocument()
  })

  test("a governed target is refused: error toast, screen kept, no acquisition", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        status: 409,
        body: {
          ok: false,
          error: "already governed",
          code: "already_governed",
        },
      })
    )
    const onImported = vi.fn()
    const user = userEvent.setup()
    const { container } = renderWithIntl(<ImportDocsFlow active onImported={onImported} />)

    await user.upload(fileInput(container), md())
    const submit = screen.getByRole("button", { name: "Import documents" })
    await waitFor(() => expect(submit).toBeEnabled())
    await user.click(submit)

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Cannot import documents",
        expect.objectContaining({
          description: "This folder is already governed by Vivicy — importing here would overwrite it.",
        })
      )
    )
    expect(onImported).not.toHaveBeenCalled()
    expect(screen.getByText("1 document ready")).toBeInTheDocument()
  })

  test("a successful import reports the acquired project and toasts count + language", async () => {
    const project = { root: "/home/dev/target", name: "target", hasCanonicalSpec: true }
    vi.stubGlobal(
      "fetch",
      stubFetch({
        body: {
          ok: true,
          batchId: "2026-07-11T00-00-00-000Z",
          targetPath: project.root,
          language: "fra",
          accepted: [{ path: "spec.md", size: 20, sha256: "x" }],
          rejected: [],
          mode: "from_scratch",
          project,
        },
      })
    )
    const onImported = vi.fn()
    const user = userEvent.setup()
    const { container } = renderWithIntl(<ImportDocsFlow active onImported={onImported} />)

    await user.upload(fileInput(container), md())
    const submit = screen.getByRole("button", { name: "Import documents" })
    await waitFor(() => expect(submit).toBeEnabled())
    await user.click(submit)

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(project))
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "Documents imported",
      expect.objectContaining({ description: "1 document imported. Detected French." })
    )
  })
})
