import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { toast } from "sonner"

import type { RegisteredProject } from "@/lib/project-types"
import { Launcher } from "@/components/launcher/launcher"
import { TooltipProvider } from "@/components/ui/tooltip"
import { renderWithIntl } from "@/test/render"

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}))

function project(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    root: "/repos/alpha",
    name: "alpha",
    port: 3100,
    url: "http://127.0.0.1:3100",
    running: false,
    missing: false,
    ...overrides,
  }
}

const RUNNING = project({ running: true })
const STOPPED = project({ root: "/repos/beta", name: "beta", port: 3101, url: "http://127.0.0.1:3101" })
const MISSING = project({ root: "/repos/gone", name: "gone", port: 3102, url: "http://127.0.0.1:3102", running: true, missing: true })

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const LISTING = {
  ok: true,
  path: "/repos",
  parent: "/",
  crumbs: [
    { label: "/", path: "/" },
    { label: "repos", path: "/repos" },
  ],
  entries: [],
}

// The root layout provides the tooltip context the row's icon actions live in; the render helper does not.
function renderLauncher(initial: RegisteredProject[]) {
  return renderWithIntl(
    <TooltipProvider>
      <Launcher initial={initial} />
    </TooltipProvider>
  )
}

function row(root: string): HTMLElement {
  const found = document.querySelector(`[data-project-root="${root}"]`)
  if (!found) throw new Error(`no row for ${root}`)
  return found as HTMLElement
}

const HOME = "http://localhost/"

// next/image reads window.location to resolve its src, so the stand-in must still be a real location shape.
beforeEach(() => {
  vi.mocked(toast.error).mockReset()
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: HOME, origin: "http://localhost", protocol: "http:", host: "localhost", hostname: "localhost", pathname: "/" },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Launcher — the row's action set is its state", () => {
  test("running rows offer focus + restart + stop; stopped rows offer open + forget; a missing folder is never openable", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(LISTING))
    )
    renderLauncher([RUNNING, STOPPED, MISSING])

    const live = within(row(RUNNING.root))
    expect(live.getByRole("button", { name: "Go to it" })).toBeInTheDocument()
    expect(live.getByRole("button", { name: /Restart/ })).toBeInTheDocument()
    expect(live.getByRole("button", { name: /Stop/ })).toBeInTheDocument()
    expect(live.queryByRole("button", { name: /Forget/ })).not.toBeInTheDocument()
    expect(live.getByText("running on port 3100")).toBeInTheDocument()

    const idle = within(row(STOPPED.root))
    expect(idle.getByRole("button", { name: "Open" })).toBeInTheDocument()
    expect(idle.getByRole("button", { name: /Forget/ })).toBeInTheDocument()
    expect(idle.queryByRole("button", { name: /Restart/ })).not.toBeInTheDocument()

    const gone = within(row(MISSING.root))
    expect(gone.queryByRole("button", { name: /^(Open|Go to it)$/ })).not.toBeInTheDocument()
    expect(gone.getByRole("button", { name: /Stop/ }), "a running server stays stoppable even with its folder gone").toBeInTheDocument()
    expect(gone.getByRole("button", { name: /Forget/ })).toBeInTheDocument()
    expect(gone.getByText("folder missing")).toBeInTheDocument()
  })
})

describe("Launcher — actions", () => {
  test("opening a project POSTs the action and hands the tab to that project's own server", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/projects") && init?.method === "POST") {
        return json({ ok: true, opened: { url: "http://127.0.0.1:3101" }, projects: [RUNNING, STOPPED] })
      }
      return json(LISTING)
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderLauncher([RUNNING, STOPPED])

    await user.click(within(row(STOPPED.root)).getByRole("button", { name: "Open" }))

    await waitFor(() => expect(window.location.href).toBe("http://127.0.0.1:3101"))
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({ action: "open", root: STOPPED.root })
  })

  test("a typed refusal renders through the projects error family and still swaps in the returned list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/api/projects") && init?.method === "POST") {
          return json({ ok: false, error: "no build", code: "not_built", projects: [STOPPED] }, 409)
        }
        return json(LISTING)
      })
    )
    const user = userEvent.setup()
    renderLauncher([RUNNING, STOPPED])

    await user.click(within(row(RUNNING.root)).getByRole("button", { name: "Go to it" }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Cannot open the project",
        expect.objectContaining({
          description: "Vivicy has no production build yet — run npm run build, then open the project again.",
        })
      )
    )
    await waitFor(() => expect(document.querySelector(`[data-project-root="${RUNNING.root}"]`)).toBeNull())
    expect(window.location.href).toBe(HOME)
  })
})

describe("Launcher — busy controls stay focusable (AGENTS.md repo-wide law)", () => {
  test("an action in flight marks every control aria-disabled, never native disabled, and a second click fires nothing", async () => {
    const gate = deferred()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/projects") && init?.method === "POST") {
        await gate.promise
        return json({ ok: true, opened: null, projects: [STOPPED] })
      }
      return json(LISTING)
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderLauncher([RUNNING, STOPPED])

    const stop = within(row(RUNNING.root)).getByRole("button", { name: /Stop/ })
    await user.click(stop)

    const posts = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST")
    await waitFor(() => expect(posts()).toHaveLength(1))

    for (const control of [
      stop,
      within(row(RUNNING.root)).getByRole("button", { name: "Go to it" }),
      within(row(STOPPED.root)).getByRole("button", { name: "Open" }),
    ]) {
      expect(control, "native disabled drops keyboard focus to <body>").not.toHaveAttribute("disabled")
      expect(control).toHaveAttribute("aria-disabled", "true")
      control.focus()
      expect(control).toHaveFocus()
    }

    await user.click(within(row(STOPPED.root)).getByRole("button", { name: "Open" }))
    expect(posts(), "a guarded no-op handler is what makes the aria-disabled control safe").toHaveLength(1)

    gate.resolve()
    await waitFor(() => expect(within(row(STOPPED.root)).getByRole("button", { name: "Open" })).toHaveAttribute("aria-disabled", "false"))
  })

  test("the folder CTA is aria-disabled while the browser has resolved no folder, and fires nothing when clicked", async () => {
    // The browse fails, so no listing ever resolves and the CTA stays locked — the state the law calls "locked", not "busy".
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init
      return String(input).includes("/api/fs/list") ? json({ ok: false, error: "nope" }, 500) : json(LISTING)
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderLauncher([])

    const cta = screen.getByRole("button", { name: "Open this folder" })
    await waitFor(() => expect(cta).toHaveAttribute("aria-disabled", "true"))
    expect(cta, "native disabled drops keyboard focus to <body>").not.toHaveAttribute("disabled")
    cta.focus()
    expect(cta).toHaveFocus()

    await user.click(cta)
    expect(fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toHaveLength(0)
  })
})
