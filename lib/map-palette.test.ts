import { describe, expect, test } from "vitest"

import {
  kindColor,
  KIND_COLORS,
  progressStatusColor,
  STATUS_COLORS,
  UNKNOWN_KIND_COLOR,
} from "@/lib/map-palette"

function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`not a #rrggbb color: ${hex}`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function isVisibleOnWhite(hex: string): boolean {
  const [r, g, b] = parseHex(hex)
  return !(r >= 240 && g >= 240 && b >= 240)
}

describe("map palette — minimap node colors (the empty-minimap fix)", () => {
  test("every KIND has a real, non-empty bg + border", () => {
    for (const kind of Object.keys(KIND_COLORS)) {
      const c = kindColor(kind)
      expect(c.bg).toMatch(/^#[0-9a-f]{6}$/i)
      expect(c.border).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  test("every STATUS has a real, non-empty bg + border", () => {
    for (const status of Object.keys(STATUS_COLORS)) {
      const c = progressStatusColor(status)
      expect(c.bg).toMatch(/^#[0-9a-f]{6}$/i)
      expect(c.border).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  test("unknown kind/status still yield a paintable token (never empty)", () => {
    const k = kindColor("does-not-exist")
    expect(k).toEqual(UNKNOWN_KIND_COLOR)
    expect(k.bg).toMatch(/^#[0-9a-f]{6}$/i)

    const s = progressStatusColor("does-not-exist")
    expect(s).toEqual(STATUS_COLORS.not_started)
  })

  test("the STROKE (border) is always visible on white — this is the fix", () => {
    for (const kind of Object.keys(KIND_COLORS)) {
      expect(isVisibleOnWhite(kindColor(kind).border)).toBe(true)
    }
    for (const status of Object.keys(STATUS_COLORS)) {
      expect(isVisibleOnWhite(progressStatusColor(status).border)).toBe(true)
    }
    expect(isVisibleOnWhite(STATUS_COLORS.not_started.bg)).toBe(false)
    expect(isVisibleOnWhite(STATUS_COLORS.not_started.border)).toBe(true)
  })
})
