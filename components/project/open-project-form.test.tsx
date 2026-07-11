import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { toast } from "sonner"

import { OpenProjectForm } from "@/components/project/open-project-form"
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

const PROJECT = { root: "/home/dev/target", name: "target", hasCanonicalSpec: true }

type ProjectPost = { method: string; body: unknown }

function stubFetch(posts: ProjectPost[], projectResponse?: { body: unknown; status?: number }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/api/fs/list")) return json(LISTING)
    if (url.includes("/api/project")) {
      posts.push({ method: String(init?.method), body: JSON.parse(String(init?.body)) })
      const r = projectResponse ?? { body: { ok: true, project: PROJECT } }
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

async function clickSelect() {
  const button = await screen.findByRole("button", { name: "Select this folder" })
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.setup().click(button)
}

beforeEach(() => {
  vi.mocked(toast.error).mockReset()
  vi.mocked(toast.success).mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("OpenProjectForm — select()", () => {
  test("picking a folder POSTs it to /api/project and reports the persisted project up", async () => {
    const posts: ProjectPost[] = []
    vi.stubGlobal("fetch", stubFetch(posts))
    const onChanged = vi.fn()

    renderWithIntl(<OpenProjectForm active onChanged={onChanged} />)
    await clickSelect()

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({
      method: "POST",
      body: { root: "/home/dev/target", requireGoverned: true },
    })

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(PROJECT))
    expect(vi.mocked(toast.success)).toHaveBeenCalled()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  test("propagates requireGoverned=false into the POST body", async () => {
    const posts: ProjectPost[] = []
    vi.stubGlobal("fetch", stubFetch(posts))

    renderWithIntl(<OpenProjectForm active requireGoverned={false} onChanged={vi.fn()} />)
    await clickSelect()

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toEqual({ root: "/home/dev/target", requireGoverned: false })
  })

  test("an ungoverned folder is refused: error toast with the not_governed reason, onChanged never fires", async () => {
    const posts: ProjectPost[] = []
    vi.stubGlobal("fetch", stubFetch(posts, { body: { ok: false, code: "not_governed" } }))
    const onChanged = vi.fn()

    renderWithIntl(<OpenProjectForm active onChanged={onChanged} />)
    await clickSelect()

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Cannot select project",
        expect.objectContaining({
          description:
            "This folder doesn't seem to be governed by Vivicy — it has no .vivicy directory.",
        })
      )
    )
    expect(onChanged).not.toHaveBeenCalled()
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
  })

  test("the select affordance stays disabled until a folder listing resolves", async () => {
    vi.stubGlobal("fetch", stubFetch([]))
    renderWithIntl(<OpenProjectForm active onChanged={vi.fn()} />)

    const button = screen.getByRole("button", { name: "Select this folder" })
    expect(button).toBeDisabled()
    await waitFor(() => expect(button).toBeEnabled())
  })
})
