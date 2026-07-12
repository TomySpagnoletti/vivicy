import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { getCycles } = vi.hoisted(() => ({ getCycles: vi.fn() }))

vi.mock("@/lib/control", async () => {
  const actual = await vi.importActual<typeof import("@/lib/control")>("@/lib/control")
  return { ...actual, getCycles }
})

import { ControlError } from "@/lib/control"

import { GET } from "./route"

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("GET /api/control/cycles", () => {
  it("returns the cycles view verbatim", async () => {
    const view = {
      active: { id: null, kind: "project", editable: true, pending_batches: 2 },
      history: [
        { baseline_id: "baseline-v1.0.0", version: "1.0.0", kind: "project", approval_ref: "project", closed_at: "2026-02-01T00:00:00Z", superseded: true },
      ],
    }
    getCycles.mockReturnValue(view)
    const body = await (await GET()).json()
    expect(body).toEqual({ ok: true, cycles: view })
  })

  it("maps a ControlError (no target) to 422 with its code, and any other error to 500", async () => {
    getCycles.mockImplementation(() => {
      throw new ControlError("no project selected", "missing_target")
    })
    let res = await GET()
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe("missing_target")

    getCycles.mockImplementation(() => {
      throw new Error("disk exploded")
    })
    res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
  })
})
