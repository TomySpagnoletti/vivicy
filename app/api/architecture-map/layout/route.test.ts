import { beforeEach, describe, expect, it, vi } from "vitest"

import type { LayoutSaveErrorCode } from "@/lib/map-layout-save"

const { validateLayoutSavePayload, applyLayoutSave } = vi.hoisted(() => ({
  validateLayoutSavePayload: vi.fn(),
  applyLayoutSave: vi.fn(),
}))

vi.mock("@/lib/map-layout-save", async () => {
  const actual = await vi.importActual<typeof import("@/lib/map-layout-save")>(
    "@/lib/map-layout-save"
  )
  return { ...actual, validateLayoutSavePayload, applyLayoutSave }
})

import { LayoutSaveError } from "@/lib/map-layout-save"

import { POST } from "./route"

const VALID_PAYLOAD = { nodes: [], edgeLabels: [] }

function postRaw(raw: string): Request {
  return new Request("http://localhost/api/architecture-map/layout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  })
}

function postJson(body: unknown): Request {
  return postRaw(JSON.stringify(body))
}

beforeEach(() => {
  vi.clearAllMocks()
  validateLayoutSavePayload.mockReturnValue(VALID_PAYLOAD)
})

describe("POST /api/architecture-map/layout", () => {
  it("returns 400 invalid_payload when the body is not valid JSON", async () => {
    const res = await POST(postRaw("{ not json"))
    expect(res.status).toBe(400)
    const body = await res.json()

    expect(body).toEqual({
      ok: false,
      error: "Request body must be valid JSON.",
      code: "invalid_payload",
    })
    expect(validateLayoutSavePayload).not.toHaveBeenCalled()
    expect(applyLayoutSave).not.toHaveBeenCalled()
  })

  it("returns {ok:true} on the happy path (200)", async () => {
    applyLayoutSave.mockResolvedValue({ ok: true, mapPath: "/abs/map.yml" })

    const res = await POST(postJson(VALID_PAYLOAD))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ ok: true })
    expect(validateLayoutSavePayload).toHaveBeenCalledWith(VALID_PAYLOAD)
    expect(applyLayoutSave).toHaveBeenCalledWith({ payload: VALID_PAYLOAD })
  })

  const cases: Array<{ code: LayoutSaveErrorCode; status: number }> = [
    { code: "read_only", status: 403 },
    { code: "no_target", status: 404 },
    { code: "no_map", status: 404 },
    { code: "invalid_payload", status: 400 },
    { code: "patch_failed", status: 400 },
    { code: "regen_failed", status: 422 },
  ]

  for (const { code, status } of cases) {
    it(`maps LayoutSaveError code "${code}" to ${status}`, async () => {
      applyLayoutSave.mockRejectedValue(new LayoutSaveError(`boom: ${code}`, code))

      const res = await POST(postJson(VALID_PAYLOAD))
      expect(res.status).toBe(status)
      const body = await res.json()

      expect(body.ok).toBe(false)
      expect(body.code).toBe(code)
      expect(body.error).toBe(`boom: ${code}`)
    })
  }

  it("maps an unexpected (non-LayoutSaveError) error to 500", async () => {
    applyLayoutSave.mockRejectedValue(new Error("spawn EACCES"))

    const res = await POST(postJson(VALID_PAYLOAD))
    expect(res.status).toBe(500)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.error).toBe("spawn EACCES")
    expect(body.code).toBeUndefined()
  })

  it("surfaces a validation-stage LayoutSaveError with its mapped status", async () => {
    validateLayoutSavePayload.mockImplementation(() => {
      throw new LayoutSaveError("bad shape", "invalid_payload")
    })

    const res = await POST(postJson({ nodes: "nope" }))
    expect(res.status).toBe(400)
    const body = await res.json()

    expect(body.code).toBe("invalid_payload")
    expect(applyLayoutSave).not.toHaveBeenCalled()
  })
})
