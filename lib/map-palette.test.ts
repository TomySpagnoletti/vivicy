import { describe, expect, test } from "vitest"

import {
  kindColor,
  KIND_COLORS,
  progressStatusColor,
  STATUS_COLORS,
  UNKNOWN_KIND_COLOR,
} from "@/lib/map-palette"

/** A `#rrggbb` (or `#rgb`) string parsed to its three 0-255 channels. */
function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`not a #rrggbb color: ${hex}`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/**
 * A color is "paintable on white" when it is not itself near-white. The minimap
 * sits on a white backdrop, so a fill like `#f8fafc` (248,250,252) is
 * effectively invisible. Treat any color whose every channel is >= 240 as
 * near-white (invisible); everything more saturated is visible.
 */
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
    // Unknown status falls back to not_started — still a real token.
    expect(s).toEqual(STATUS_COLORS.not_started)
  })

  test("the STROKE (border) is always visible on white — this is the fix", () => {
    // The previous minimap filled with `bg` only; pale fills like
    // not_started (#f8fafc) vanished on the white minimap, so it looked EMPTY.
    // Painting the saturated `border` as the node stroke keeps EVERY node
    // visible regardless of how pale its fill is. Prove every border qualifies.
    for (const kind of Object.keys(KIND_COLORS)) {
      expect(isVisibleOnWhite(kindColor(kind).border)).toBe(true)
    }
    for (const status of Object.keys(STATUS_COLORS)) {
      expect(isVisibleOnWhite(progressStatusColor(status).border)).toBe(true)
    }
    // Concretely: not_started's pale fill is near-white (the empty cause)...
    expect(isVisibleOnWhite(STATUS_COLORS.not_started.bg)).toBe(false)
    // ...but its border is a visible slate, so the minimap rect still shows.
    expect(isVisibleOnWhite(STATUS_COLORS.not_started.border)).toBe(true)
  })
})
