import { describe, expect, it } from "vitest"

import {
  ensureManagedBlock,
  GITIGNORE_MARKERS,
  METHOD_MARKERS,
  type ManagedSpec,
} from "@/lib/managed-block"

const MARKERS = { begin: "<!-- b -->", end: "<!-- e -->" }
const BLOCK = `${MARKERS.begin}\ncanonical line\n${MARKERS.end}`
const TEMPLATE = `# Greenfield\n\nintro prose\n\n${BLOCK}\n\ntail prose\n`

function spec(over: Partial<ManagedSpec> = {}): ManagedSpec {
  return { block: BLOCK, template: TEMPLATE, markers: MARKERS, ...over }
}

// The engine's seam is bytes; these cases are pure ASCII, so encoding both ways keeps them readable as text. The byte-level pins below work on Buffers directly.
function apply(current: string | null, over: ManagedSpec = spec()): string {
  return ensureManagedBlock(current === null ? null : Buffer.from(current, "utf8"), over).toString("utf8")
}

describe("ensureManagedBlock — the four states", () => {
  it("absent → writes the greenfield template verbatim", () => {
    expect(apply(null)).toBe(TEMPLATE)
  })

  it("present without markers → appends the block at EOF with one blank-line separator and a clean trailing newline", () => {
    const owner = "# Owner file\n\nsome rules\n"
    expect(apply(owner)).toBe(`# Owner file\n\nsome rules\n\n${BLOCK}\n`)
  })

  it("present without markers, no trailing newline → still separated by exactly one blank line", () => {
    expect(apply("no newline")).toBe(`no newline\n\n${BLOCK}\n`)
  })

  it("an empty owner file → the block becomes the whole content, no leading blank lines", () => {
    expect(apply("")).toBe(`${BLOCK}\n`)
  })

  it("block present and canonical → no-op (byte-identical)", () => {
    const current = `# Owner\n\n${BLOCK}\n\nafter\n`
    expect(apply(current)).toBe(current)
  })

  it("block present but altered → restores the canonical block, owner text outside byte-identical", () => {
    const current = `# Owner\n\n${MARKERS.begin}\nsomebody deleted the essentials\nand edited them\n${MARKERS.end}\n\nafter\n`
    expect(apply(current)).toBe(`# Owner\n\n${BLOCK}\n\nafter\n`)
  })

  it("preserves owner bytes on BOTH sides of the block exactly (no newline drift)", () => {
    const current = `head1\nhead2\n${MARKERS.begin}\nX\n${MARKERS.end}\ntail1\ntail2`
    const result = apply(current)
    expect(result).toBe(`head1\nhead2\n${BLOCK}\ntail1\ntail2`)
    expect(result.startsWith("head1\nhead2\n")).toBe(true)
    expect(result.endsWith("\ntail1\ntail2")).toBe(true)
  })
})

describe("ensureManagedBlock — the owner's bytes, whatever encoding they are in", () => {
  // The block Vivicy writes is UTF-8 and carries non-ASCII (the templates are full of em dashes), while the owner's file may be latin-1: encoding the block as latin-1 too would mojibake it, decoding their bytes as UTF-8 would replace every accent with U+FFFD. Both directions are pinned here, at the byte level — EF BF BD is what a lossy decode leaves behind.
  const BLOCK_UTF8 = `${MARKERS.begin}\ncanonical — line\n${MARKERS.end}`
  const REPLACEMENT_CHAR = Buffer.from([0xef, 0xbf, 0xbd])
  const utf8Spec = spec({ block: BLOCK_UTF8 })
  const latin1 = (text: string) => Buffer.from(text, "latin1")

  it("a latin-1 file keeps every owner byte through a REAL block update, and the block lands as UTF-8", () => {
    const head = latin1("# clé privée\nmot-de-passé\n")
    const tail = latin1("# à garder\n")
    const current = Buffer.concat([head, latin1(`${MARKERS.begin}\nstale\n${MARKERS.end}\n`), tail])

    const out = ensureManagedBlock(current, utf8Spec)

    expect(out.subarray(0, head.length).equals(head), "owner bytes before the block").toBe(true)
    expect(out.subarray(out.length - tail.length).equals(tail), "owner bytes after the block").toBe(true)
    expect(out.includes(REPLACEMENT_CHAR), "nothing was decoded and re-encoded").toBe(false)
    expect(out.includes(Buffer.from(BLOCK_UTF8, "utf8")), "the block keeps its own UTF-8 bytes").toBe(true)
    expect(ensureManagedBlock(out, utf8Spec).equals(out), "and the second pass is a zero diff").toBe(true)
  })

  it("a latin-1 file with no markers keeps its bytes through the append path too", () => {
    const owner = latin1("node_modules/\n# secrète\n")
    const out = ensureManagedBlock(owner, utf8Spec)

    expect(out.subarray(0, owner.length).equals(owner)).toBe(true)
    expect(out.includes(REPLACEMENT_CHAR)).toBe(false)
    expect(out.equals(Buffer.concat([owner, latin1("\n"), Buffer.from(`${BLOCK_UTF8}\n`, "utf8")]))).toBe(true)
  })

  it("a UTF-8 BOM is the owner's byte and stays first", () => {
    const out = ensureManagedBlock(Buffer.from("﻿# owner\n", "utf8"), utf8Spec)
    expect(out.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true)
    expect(out.toString("utf8")).toBe(`﻿# owner\n\n${BLOCK_UTF8}\n`)
  })
})

describe("ensureManagedBlock — idempotence", () => {
  it("a second pass over an appended file is a zero diff", () => {
    const once = apply("# Owner\n")
    expect(apply(once)).toBe(once)
  })

  it("a second pass over a restored file is a zero diff", () => {
    const altered = `pre\n${MARKERS.begin}\nwrong\n${MARKERS.end}\npost\n`
    const restored = apply(altered)
    expect(apply(restored)).toBe(restored)
  })

  it("the greenfield template is itself a fixpoint when it embeds the canonical block", () => {
    const greenfield = apply(null)
    expect(apply(greenfield)).toBe(greenfield)
  })
})

describe("ensureManagedBlock — marker-lookalike owner text", () => {
  it("text that merely resembles a marker (not an exact full line) is owner text: block appended, lookalike preserved byte-intact", () => {
    const owner = `# Owner\n\nSee ${MARKERS.begin} inline, and\n${MARKERS.begin} trailing words\n  ${MARKERS.begin}\n`
    const result = apply(owner)
    expect(result).toBe(`${owner.replace(/\n+$/, "")}\n\n${BLOCK}\n`)
    expect(result).toContain(`See ${MARKERS.begin} inline, and`)
    expect(result).toContain(`${MARKERS.begin} trailing words`)
    expect(result).toContain(`  ${MARKERS.begin}`)
  })

  it("a CRLF marker line still matches so a Windows-authored governed file re-normalizes without duplicating the block", () => {
    const current = `owner\r\n${MARKERS.begin}\r\nstale\r\n${MARKERS.end}\r\ntail\r\n`
    const result = apply(current)
    expect(result.match(new RegExp(MARKERS.begin, "g"))).toHaveLength(1)
    expect(result).toContain(BLOCK)
    expect(result).toContain("owner\r\n")
    expect(result).toContain("tail\r\n")
    expect(result).not.toContain("stale")
    expect(apply(result)).toBe(result)
  })
})

describe("ensureManagedBlock — damaged markers self-repair, never block", () => {
  // A span's interior is block content and goes, exactly as on the healthy in-place path — but only for a MUTUALLY nearest begin/end pair, so lines between two begins stay the owner's.
  const cases: Array<{ name: string; current: string; owner: string }> = [
    { name: "duplicated begin marker", current: `a\n${MARKERS.begin}\nx\n${MARKERS.begin}\ny\n${MARKERS.end}\n`, owner: "a\nx\n" },
    { name: "duplicated end marker", current: `${MARKERS.begin}\nx\n${MARKERS.end}\ny\n${MARKERS.end}\n`, owner: "y\n" },
    { name: "begin without end", current: `head\n${MARKERS.begin}\nx\ny\n`, owner: "head\nx\ny\n" },
    { name: "end without begin", current: `head\nx\n${MARKERS.end}\ntail\n`, owner: "head\nx\ntail\n" },
    { name: "end before begin", current: `${MARKERS.end}\nx\n${MARKERS.begin}\n`, owner: "x\n" },
    { name: "two whole blocks around owner prose", current: `${MARKERS.begin}\nA\n${MARKERS.end}\nmine\n${MARKERS.begin}\nB\n${MARKERS.end}\n`, owner: "mine\n" },
    { name: "a stray begin above a real block — the owner lines between the two begins are NOT swallowed", current: `keep1\n${MARKERS.begin}\nkeep2\n${MARKERS.begin}\nblock\n${MARKERS.end}\n`, owner: "keep1\nkeep2\n" },
    { name: "nested begins with two ends pair innermost-first, the outer line survives", current: `${MARKERS.begin}\nkeep\n${MARKERS.begin}\nblock\n${MARKERS.end}\n${MARKERS.end}\n`, owner: "keep\n" },
  ]
  for (const { name, current, owner } of cases) {
    it(`${name} → residues cleaned, one pristine block restored, owner lines byte-preserved`, () => {
      const repaired = apply(current)
      expect(repaired).toBe(`${owner.replace(/\n+$/, "")}\n\n${BLOCK}\n`)
      expect(repaired.split(MARKERS.begin)).toHaveLength(2)
      expect(repaired.split(MARKERS.end)).toHaveLength(2)
      expect(apply(repaired), "a second pass over the repair is a zero diff").toBe(repaired)
    })
  }

  it("a file that is nothing but marker residue converges to the block alone, no leading blank lines", () => {
    const repaired = apply(`${MARKERS.end}\n${MARKERS.begin}\n`)
    expect(repaired).toBe(`${BLOCK}\n`)
    expect(apply(repaired)).toBe(repaired)
  })

  it("marker LOOKALIKES around real residue are owner text: preserved verbatim while the residue is cleaned", () => {
    const current = `  ${MARKERS.begin}\n${MARKERS.end}\nSee ${MARKERS.end} inline\n`
    const repaired = apply(current)
    expect(repaired).toBe(`  ${MARKERS.begin}\nSee ${MARKERS.end} inline\n\n${BLOCK}\n`)
    expect(apply(repaired)).toBe(repaired)
  })
})

describe("ensureManagedBlock — totality is exhaustive, not sampled", () => {
  // "Never throws on any input" cannot be shown by enumerated shapes, so walk EVERY arrangement of the alphabet that decides the outcome (both markers, their CRLF spellings, a lookalike, an owner line, a blank), each with and without a trailing newline.
  const ALPHABET = [MARKERS.begin, MARKERS.end, `${MARKERS.begin}\r`, `${MARKERS.end}\r`, "owner", "", `  ${MARKERS.begin}`]
  const MAX_LINES = 5

  function bare(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line
  }

  // The POLICY, stated declaratively so it shares no scan with the implementation: a pair is MUTUALLY nearest — b is the last begin before e AND e is the first end after b. Only such a pair's span is Vivicy's; every other non-marker line is the owner's.
  function ownerLines(text: string): string[] {
    const lines = text.split("\n").map(bare)
    const at = (kind: string) => lines.flatMap((line, i) => (line === kind ? [i] : []))
    const begins = at(MARKERS.begin)
    const ends = at(MARKERS.end)
    const owned = new Set<number>()
    for (const e of ends) {
      const b = begins.filter((candidate) => candidate < e).at(-1)
      if (b === undefined || ends.find((candidate) => candidate > b) !== e) continue
      for (let i = b; i <= e; i += 1) owned.add(i)
    }
    return lines.filter(
      (line, i) => !owned.has(i) && line !== MARKERS.begin && line !== MARKERS.end && line.trim().length > 0
    )
  }

  function* arrangements(): Generator<string> {
    let level = [""]
    for (let depth = 0; depth <= MAX_LINES; depth += 1) {
      for (const body of level) {
        yield body
        yield `${body}\n`
      }
      level = level.flatMap((body) => ALPHABET.map((line) => (body === "" ? line : `${body}\n${line}`)))
    }
  }

  it("every arrangement converges to exactly one well-formed block, is a fixpoint, and keeps every owner line", () => {
    let seen = 0
    for (const input of arrangements()) {
      seen += 1
      const out = apply(input)
      const outLines = out.split("\n").map(bare)
      const why = JSON.stringify(input)
      expect(outLines.filter((line) => line === MARKERS.begin), `one begin marker for ${why}`).toHaveLength(1)
      expect(outLines.filter((line) => line === MARKERS.end), `one end marker for ${why}`).toHaveLength(1)
      expect(outLines.indexOf(MARKERS.begin), `begin before end for ${why}`).toBeLessThan(outLines.indexOf(MARKERS.end))
      expect(out, `canonical block content for ${why}`).toContain(BLOCK)
      expect(apply(out), `fixpoint for ${why}`).toBe(out)
      expect(ownerLines(out), `owner lines for ${why}`).toEqual(ownerLines(input))
    }
    expect(seen, "the walk must actually cover the arrangement space").toBeGreaterThan(30_000)
  })
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
    const md = apply("# owner\n", mdSpec)
    expect(apply(md, mdSpec)).toBe(md)
    const gi = apply("secrets/\n", giSpec)
    expect(gi.endsWith(`${GITIGNORE_MARKERS.end}\n`)).toBe(true)
    expect(apply(gi, giSpec)).toBe(gi)
  })
})
