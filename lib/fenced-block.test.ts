import { describe, expect, it } from "vitest"

import { readFencedBlock, stripFencedBlock } from "@/lib/fenced-block"

const TAG = "vivicy-questions"

describe("readFencedBlock — the one reader of a directive block", () => {
  it("reads the body between the tagged fence and the next closing fence", () => {
    const reply = `Two things.\n\n\`\`\`${TAG}\n[{"id": "a"}]\n\`\`\``
    expect(readFencedBlock(reply, TAG)?.body).toBe('[{"id": "a"}]')
  })

  it("reads a multi-line body verbatim, blank lines included", () => {
    const reply = `lead\n\n\`\`\`${TAG}\n[\n\n  {"id": "a"}\n]\n\`\`\`\ntail`
    expect(readFencedBlock(reply, TAG)?.body).toBe('[\n\n  {"id": "a"}\n]')
  })

  it("returns null with no fence, and with an unclosed one", () => {
    expect(readFencedBlock("no fence here", TAG)).toBeNull()
    expect(readFencedBlock(`\`\`\`${TAG}\n[{"id": "a"}]`, TAG)).toBeNull()
  })

  it("skips an opening whose tag line carries other text, and takes the next real one", () => {
    const reply = `\`\`\`${TAG}-ish nope\n\n\`\`\`${TAG}\nok\n\`\`\``
    expect(readFencedBlock(reply, TAG)?.body).toBe("ok")
  })

  it("takes the FIRST block when a reply carries two", () => {
    const reply = `\`\`\`${TAG}\nfirst\n\`\`\`\n\n\`\`\`${TAG}\nsecond\n\`\`\``
    expect(readFencedBlock(reply, TAG)?.body).toBe("first")
  })

  it("reports an empty block as empty rather than as no block at all", () => {
    expect(readFencedBlock(`\`\`\`${TAG}\n\`\`\``, TAG)?.body).toBe("")
  })

  it("tolerates an indented closing fence and trailing text after it", () => {
    expect(readFencedBlock(`\`\`\`${TAG}\nbody\n   \`\`\` and more`, TAG)?.body).toBe("body")
  })

  it("refuses a reply that repeats the open tag mid-line and never closes it, without rescanning the tail per occurrence", () => {
    const line = `- \`\`\`${TAG}\n`
    const hostile = line.repeat(Math.ceil(200_000 / line.length))
    const started = performance.now()
    expect(readFencedBlock(hostile, TAG)).toBeNull()
    expect(performance.now() - started).toBeLessThan(100)
  })

  it("skips a run of tag lines carrying other text and still finds the real block behind them", () => {
    const noise = `- \`\`\`${TAG} nope\n`.repeat(500)
    expect(readFencedBlock(`${noise}\`\`\`${TAG}\nbody\n\`\`\``, TAG)?.body).toBe("body")
  })

  it("never refuses a reply that does carry a closing line after its first open", () => {
    const noise = `- \`\`\`${TAG}\n`.repeat(500)
    const block = readFencedBlock(`${noise}\`\`\`${TAG}\nbody\n\`\`\``, TAG)
    expect(block).not.toBeNull()
    expect(block?.start).toBe(2)
  })

  it("stays linear on a hostile unclosed fence followed by a run of whitespace", () => {
    const hostile = `\`\`\`${TAG}\n${"\n".repeat(200_000)}${"x".repeat(200_000)}`
    const started = performance.now()
    expect(readFencedBlock(hostile, TAG)).toBeNull()
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it("stays linear on a hostile block whose body is one long whitespace run", () => {
    const hostile = `\`\`\`${TAG}\n${" \n".repeat(200_000)}\n\`\`\``
    const started = performance.now()
    expect(readFencedBlock(hostile, TAG)?.body.length).toBeGreaterThan(0)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe("stripFencedBlock — the block never reaches the thread", () => {
  it("removes exactly the block and closes the hole it leaves", () => {
    expect(stripFencedBlock(`Two things.\n\n\`\`\`${TAG}\n[]\n\`\`\``, TAG)).toBe("Two things.")
  })

  it("keeps the prose on both sides of the block", () => {
    expect(stripFencedBlock(`before\n\n\`\`\`${TAG}\n[]\n\`\`\`\n\nafter`, TAG)).toBe("before\n\nafter")
  })

  it("leaves a reply carrying no such block byte-identical", () => {
    expect(stripFencedBlock("nothing to strip", TAG)).toBe("nothing to strip")
    expect(stripFencedBlock("```other\nx\n```", TAG)).toBe("```other\nx\n```")
  })
})
