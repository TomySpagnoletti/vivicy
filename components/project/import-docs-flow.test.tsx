import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { toast } from "sonner"

import { ImportDocsFlow } from "@/components/project/import-docs-flow"
import { ViviPanelProvider } from "@/components/chat/vivi-panel-context"
import { SUPPORTED_EXTENSIONS } from "@/lib/import-docs"
import { ZIP_TRANSPORT_EXTENSION } from "@/lib/supported-extensions"
import { renderWithIntl } from "@/test/render"

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}))

function stubFetch(importResponse?: { body: unknown; status?: number }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init
    const url = String(input)
    if (url.includes("/api/vivi/import")) {
      const r = importResponse ?? { body: { ok: true, accepted: [], rejected: [] } }
      return json(r.body, r.status)
    }
    if (url.includes("/api/vivi/sessions")) return json({ ok: true, sessions })
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

let sessions: { sessionId: string }[] = []

function renderImport(onImported: () => void) {
  return renderWithIntl(
    <ViviPanelProvider>
      <ImportDocsFlow active onImported={onImported} />
    </ViviPanelProvider>
  )
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
  sessions = []
  window.localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ImportDocsFlow — docs land in the project this server governs", () => {
  test("there is no folder to browse: only the dropzone and one disabled CTA until a document is added", () => {
    vi.stubGlobal("fetch", stubFetch())
    renderImport(vi.fn())

    expect(screen.queryByLabelText("Current path")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "New folder" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Import documents" })).toHaveAttribute("aria-disabled", "true")
  })

  test("the single file picker's accept-list is exactly the server allowlist plus the .zip transport", () => {
    vi.stubGlobal("fetch", stubFetch())
    const { container } = renderImport(vi.fn())

    const inputs = container.querySelectorAll('input[type="file"]')
    expect(inputs).toHaveLength(1)
    expect(inputs[0].hasAttribute("webkitdirectory")).toBe(false)

    const rendered = (fileInput(container).getAttribute("accept") ?? "").split(",")
    const serverAllowlist = [...SUPPORTED_EXTENSIONS, ZIP_TRANSPORT_EXTENSION]
    expect([...rendered].sort()).toEqual([...serverAllowlist].sort())
  })

  test("an accepted document alone arms the import CTA", async () => {
    vi.stubGlobal("fetch", stubFetch())
    const user = userEvent.setup()
    const { container } = renderImport(vi.fn())

    await user.upload(fileInput(container), md())

    expect(await screen.findByText("1 document ready")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole("button", { name: "Import documents" })).toHaveAttribute("aria-disabled", "false"))
  })

  test("a dropped unsupported file is marked skipped; only the supported one satisfies the gate", async () => {
    vi.stubGlobal("fetch", stubFetch())
    renderImport(vi.fn())

    dropFiles([exe()])
    const row = (await screen.findByText("notes.exe")).closest("div") as HTMLElement
    expect(within(row).getByText("unsupported")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Import documents" })).toHaveAttribute("aria-disabled", "true")

    dropFiles([md(), exe()])
    expect(await screen.findByText("1 document ready", { exact: false })).toBeInTheDocument()
    expect(screen.getByText("1 file skipped", { exact: false })).toBeInTheDocument()
  })

  test("a project that lost its governance is refused: error toast, screen kept, nothing reported up", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        status: 409,
        body: { ok: false, error: "not governed", code: "not_governed" },
      })
    )
    const onImported = vi.fn()
    const user = userEvent.setup()
    const { container } = renderImport(onImported)

    await user.upload(fileInput(container), md())
    const submit = screen.getByRole("button", { name: "Import documents" })
    await waitFor(() => expect(submit).toHaveAttribute("aria-disabled", "false"))
    await user.click(submit)

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Cannot import documents",
        expect.objectContaining({
          description: "this project is no longer governed by Vivicy — its .vivicy directory is missing",
        })
      )
    )
    expect(onImported).not.toHaveBeenCalled()
    expect(screen.getByText("1 document ready")).toBeInTheDocument()
  })

  test("a successful import POSTs the files to the Vivi import seam and toasts count + language", async () => {
    const fetchMock = stubFetch({
      body: {
        ok: true,
        sessionId: "11111111-1111-1111-1111-111111111111",
        language: "fra",
        accepted: [{ path: "spec.md", size: 20, sha256: "x" }],
        rejected: [],
      },
    })
    vi.stubGlobal("fetch", fetchMock)
    const onImported = vi.fn()
    const user = userEvent.setup()
    const { container } = renderImport(onImported)

    await user.upload(fileInput(container), md())
    const submit = screen.getByRole("button", { name: "Import documents" })
    await waitFor(() => expect(submit).toHaveAttribute("aria-disabled", "false"))
    await user.click(submit)

    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1))
    const post = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/vivi/import"))
    const form = (post?.[1] as RequestInit).body as FormData
    expect(form.get("targetDir"), "the folder is the server's binding, never a field the browser can choose").toBeNull()
    expect(form.getAll("files")).toHaveLength(1)
    expect(window.localStorage.getItem("vivicy:vivi-panel-open"), "the owner is taken to the thread Vivi answers in").toBe("true")
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "Documents imported",
      expect.objectContaining({ description: "1 document imported. Detected French." })
    )
  })

  test("the batch rides the NEWEST session id, so its acknowledgement lands in the thread the panel shows", async () => {
    sessions = [{ sessionId: "22222222-2222-2222-2222-222222222222" }]
    const fetchMock = stubFetch()
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    const { container } = renderImport(vi.fn())

    await user.upload(fileInput(container), md())
    const submit = screen.getByRole("button", { name: "Import documents" })
    await waitFor(() => expect(submit).toHaveAttribute("aria-disabled", "false"))
    await user.click(submit)

    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalled())
    const post = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/vivi/import"))
    const form = (post?.[1] as RequestInit).body as FormData
    expect(
      form.get("sessionId"),
      "without it the server mints a fresh session and the whole import turn lands where nothing ever looks"
    ).toBe("22222222-2222-2222-2222-222222222222")
  })

  test("with no session yet the seam mints one — the panel then hydrates on that very session", async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    const { container } = renderImport(vi.fn())

    await user.upload(fileInput(container), md())
    const submit = screen.getByRole("button", { name: "Import documents" })
    await waitFor(() => expect(submit).toHaveAttribute("aria-disabled", "false"))
    await user.click(submit)

    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalled())
    const post = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/vivi/import"))
    expect(((post?.[1] as RequestInit).body as FormData).get("sessionId")).toBeNull()
  })
})
