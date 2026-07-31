import { render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { CurrentProject } from "@/lib/project-types"
import { useReopenPersistedProject } from "@/hooks/use-reopen-persisted-project"

const GOVERNED: CurrentProject = { root: "/repos/acme", name: "acme", hasCanonicalSpec: true }

function Probe({ project }: { project: CurrentProject | null | undefined }) {
  useReopenPersistedProject(project)
  return null
}

let fetchMock: ReturnType<typeof vi.fn>

function seamPosts(): Array<{ url: string; body: unknown }> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([input, init]) => ({
      url: String(input),
      body: JSON.parse(String((init as RequestInit).body)),
    }))
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("useReopenPersistedProject", () => {
  test("re-fires the selection seam for the persisted governed root once the boot GET resolves", async () => {
    const { rerender } = render(<Probe project={undefined} />)
    await flush()
    expect(seamPosts(), "nothing fires while the resolution is still in flight").toHaveLength(0)

    rerender(<Probe project={GOVERNED} />)
    await flush()

    expect(seamPosts()).toEqual([{ url: "/api/project", body: { root: GOVERNED.root, requireGoverned: true } }])
  })

  test("never fires a second time, however often the project resolves again", async () => {
    const { rerender } = render(<Probe project={undefined} />)
    rerender(<Probe project={GOVERNED} />)
    await flush()

    rerender(<Probe project={{ ...GOVERNED }} />)
    rerender(<Probe project={{ ...GOVERNED }} />)
    rerender(<Probe project={{ root: "/repos/other", name: "other", hasCanonicalSpec: true }} />)
    await flush()

    expect(
      seamPosts(),
      "a later project arrives through the picker, which POSTs it itself — re-firing here would renormalize on every Vivi turn"
    ).toHaveLength(1)
  })

  test("boots with NO persisted project: the seam is never fired, and stays unfired for that session", async () => {
    const { rerender } = render(<Probe project={undefined} />)
    rerender(<Probe project={null} />)
    await flush()
    expect(seamPosts(), "there is nothing to renormalize").toHaveLength(0)

    rerender(<Probe project={GOVERNED} />)
    await flush()
    expect(seamPosts(), "the one shot is spent on the first resolution, whatever it resolved to").toHaveLength(0)
  })

  test("boots with a persisted but UNGOVERNED project: the seam is never fired", async () => {
    const { rerender } = render(<Probe project={undefined} />)
    rerender(<Probe project={{ root: "/repos/plain", name: "plain", hasCanonicalSpec: false }} />)
    await flush()

    expect(seamPosts(), "no .vivicy/ means nothing Vivicy governs").toHaveLength(0)
  })

  test("a rejected seam call is swallowed: its failures are the server's to surface, and a boot must not break on it", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    const { rerender } = render(<Probe project={undefined} />)
    rerender(<Probe project={GOVERNED} />)
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
