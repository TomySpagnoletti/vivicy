import { describe, expect, it } from "vitest"

import {
  ensureManagedBlock,
  GITIGNORE_MARKERS,
  ManagedBlockError,
  METHOD_MARKERS,
  type ManagedSpec,
} from "@/lib/managed-block"

const MARKERS = { begin: "<!-- b -->", end: "<!-- e -->" }
const BLOCK = `${MARKERS.begin}\ncanonical line\n${MARKERS.end}`
const TEMPLATE = `# Greenfield\n\nintro prose\n\n${BLOCK}\n\ntail prose\n`

function spec(over: Partial<ManagedSpec> = {}): ManagedSpec {
  return { block: BLOCK, template: TEMPLATE, markers: MARKERS, ...over }
}

describe("ensureManagedBlock — the four states", () => {
  it("absent → writes the greenfield template verbatim", () => {
    expect(ensureManagedBlock(null, spec())).toBe(TEMPLATE)
  })

  it("present without markers → appends the block at EOF with one blank-line separator and a clean trailing newline", () => {
    const owner = "# Owner file\n\nsome rules\n"
    expect(ensureManagedBlock(owner, spec())).toBe(`# Owner file\n\nsome rules\n\n${BLOCK}\n`)
  })

  it("present without markers, no trailing newline → still separated by exactly one blank line", () => {
    expect(ensureManagedBlock("no newline", spec())).toBe(`no newline\n\n${BLOCK}\n`)
  })

  it("an empty owner file → the block becomes the whole content, no leading blank lines", () => {
    expect(ensureManagedBlock("", spec())).toBe(`${BLOCK}\n`)
  })

  it("block present and canonical → no-op (byte-identical)", () => {
    const current = `# Owner\n\n${BLOCK}\n\nafter\n`
    expect(ensureManagedBlock(current, spec())).toBe(current)
  })

  it("block present but altered → restores the canonical block, owner text outside byte-identical", () => {
    const current = `# Owner\n\n${MARKERS.begin}\nsomebody deleted the essentials\nand edited them\n${MARKERS.end}\n\nafter\n`
    expect(ensureManagedBlock(current, spec())).toBe(`# Owner\n\n${BLOCK}\n\nafter\n`)
  })

  it("preserves owner bytes on BOTH sides of the block exactly (no newline drift)", () => {
    const current = `head1\nhead2\n${MARKERS.begin}\nX\n${MARKERS.end}\ntail1\ntail2`
    const result = ensureManagedBlock(current, spec())
    expect(result).toBe(`head1\nhead2\n${BLOCK}\ntail1\ntail2`)
    expect(result.startsWith("head1\nhead2\n")).toBe(true)
    expect(result.endsWith("\ntail1\ntail2")).toBe(true)
  })
})

describe("ensureManagedBlock — idempotence", () => {
  it("a second pass over an appended file is a zero diff", () => {
    const once = ensureManagedBlock("# Owner\n", spec())
    expect(ensureManagedBlock(once, spec())).toBe(once)
  })

  it("a second pass over a restored file is a zero diff", () => {
    const altered = `pre\n${MARKERS.begin}\nwrong\n${MARKERS.end}\npost\n`
    const restored = ensureManagedBlock(altered, spec())
    expect(ensureManagedBlock(restored, spec())).toBe(restored)
  })

  it("the greenfield template is itself a fixpoint when it embeds the canonical block", () => {
    const greenfield = ensureManagedBlock(null, spec())
    expect(ensureManagedBlock(greenfield, spec())).toBe(greenfield)
  })
})

describe("ensureManagedBlock — marker-lookalike owner text", () => {
  it("text that merely resembles a marker (not an exact full line) is owner text: block appended, lookalike preserved byte-intact", () => {
    const owner = `# Owner\n\nSee ${MARKERS.begin} inline, and\n${MARKERS.begin} trailing words\n  ${MARKERS.begin}\n`
    const result = ensureManagedBlock(owner, spec())
    expect(result).toBe(`${owner.replace(/\n+$/, "")}\n\n${BLOCK}\n`)
    expect(result).toContain(`See ${MARKERS.begin} inline, and`)
    expect(result).toContain(`${MARKERS.begin} trailing words`)
    expect(result).toContain(`  ${MARKERS.begin}`)
  })

  it("a CRLF marker line still matches so a Windows-authored governed file re-normalizes without duplicating the block", () => {
    const current = `owner\r\n${MARKERS.begin}\r\nstale\r\n${MARKERS.end}\r\ntail\r\n`
    const result = ensureManagedBlock(current, spec())
    expect(result.match(new RegExp(MARKERS.begin, "g"))).toHaveLength(1)
    expect(result).toContain(BLOCK)
    expect(result).toContain("owner\r\n")
    expect(result).toContain("tail\r\n")
    expect(result).not.toContain("stale")
    expect(ensureManagedBlock(result, spec())).toBe(result)
  })
})

describe("ensureManagedBlock — corruption edges are deterministic and never destructive", () => {
  const cases: Array<{ name: string; current: string; reason: ManagedBlockError["reason"] }> = [
    { name: "duplicated begin marker", current: `a\n${MARKERS.begin}\nx\n${MARKERS.begin}\ny\n${MARKERS.end}\n`, reason: "duplicate_begin_marker" },
    { name: "duplicated end marker", current: `${MARKERS.begin}\nx\n${MARKERS.end}\ny\n${MARKERS.end}\n`, reason: "duplicate_end_marker" },
    { name: "begin without end", current: `head\n${MARKERS.begin}\nx\ny\n`, reason: "unterminated_block" },
    { name: "end without begin", current: `head\nx\n${MARKERS.end}\ntail\n`, reason: "stray_end_marker" },
    { name: "end before begin", current: `${MARKERS.end}\nx\n${MARKERS.begin}\n`, reason: "misordered_markers" },
  ]
  for (const { name, current, reason } of cases) {
    it(`${name} → typed refusal, file untouched`, () => {
      expect(() => ensureManagedBlock(current, spec())).toThrow(ManagedBlockError)
      try {
        ensureManagedBlock(current, spec())
      } catch (error) {
        expect((error as ManagedBlockError).reason).toBe(reason)
      }
    })
  }
})

describe("ensureManagedBlock — real marker idioms", () => {
  it("the markdown method idiom and the .gitignore idiom are distinct and both round-trip", () => {
    const mdSpec: ManagedSpec = {
      markers: METHOD_MARKERS,
      block: `${METHOD_MARKERS.begin}\n## m\n${METHOD_MARKERS.end}`,
      template: `T\n${METHOD_MARKERS.begin}\n## m\n${METHOD_MARKERS.end}\n`,
    }
    const giSpec: ManagedSpec = {
      markers: GITIGNORE_MARKERS,
      block: `${GITIGNORE_MARKERS.begin}\n.vivicy-runtime/\n${GITIGNORE_MARKERS.end}`,
      template: `node_modules/\n${GITIGNORE_MARKERS.begin}\n.vivicy-runtime/\n${GITIGNORE_MARKERS.end}\n`,
    }
    expect(METHOD_MARKERS.begin).not.toBe(GITIGNORE_MARKERS.begin)
    const md = ensureManagedBlock("# owner\n", mdSpec)
    expect(ensureManagedBlock(md, mdSpec)).toBe(md)
    const gi = ensureManagedBlock("secrets/\n", giSpec)
    expect(gi.endsWith(`${GITIGNORE_MARKERS.end}\n`)).toBe(true)
    expect(ensureManagedBlock(gi, giSpec)).toBe(gi)
  })
})
