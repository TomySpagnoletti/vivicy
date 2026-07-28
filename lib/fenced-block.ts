// The one reader of every ```<tag> … ``` directive block an agent reply carries. It scans lines instead of matching a regex because the obvious pattern (/```tag\s*\n([\s\S]*?)\n\s*```/) backtracks CATASTROPHICALLY on a reply that opens the fence and never closes it — measured cubic, so a few thousand newlines wedge the event loop, and an agent reply, whose length nothing upstream caps, is exactly where such a string arrives. Both hostile shapes the scan is built against — the unclosed fence and the tag repeated mid-line without ever closing — are pinned in lib/fenced-block.test.ts at 200 000 characters.
interface FencedBlock {
  body: string
  start: number
  end: number
}

function lineEndAt(text: string, from: number): number {
  const at = text.indexOf("\n", from)
  return at === -1 ? text.length : at
}

function closingFence(text: string, bodyStart: number): { bodyEnd: number; end: number } | null {
  let lineStart = bodyStart
  for (;;) {
    const lineEnd = lineEndAt(text, lineStart)
    const line = text.slice(lineStart, lineEnd)
    const indent = line.length - line.trimStart().length
    if (line.trimStart().startsWith("```")) {
      return {
        bodyEnd: lineStart === bodyStart ? bodyStart : lineStart - 1,
        end: lineStart + indent + 3,
      }
    }
    if (lineEnd === text.length) return null
    lineStart = lineEnd + 1
  }
}

export function readFencedBlock(text: string, tag: string): FencedBlock | null {
  const open = `\`\`\`${tag}`
  let from = 0
  for (;;) {
    const start = text.indexOf(open, from)
    if (start === -1) return null
    const openEnd = lineEndAt(text, start + open.length)
    if (text.slice(start + open.length, openEnd).trim().length === 0 && openEnd < text.length) {
      const closing = closingFence(text, openEnd + 1)
      // A failed scan proves no closing line exists at or after this offset, and every later occurrence of the tag opens FURTHER IN — a suffix of a range with no closing line has none either. Refusing here instead of advancing is what keeps the whole read linear: rescanning the tail per occurrence is quadratic on a reply that repeats the tag mid-line, which an ordinary markdown list of them does.
      if (closing === null) return null
      return { body: text.slice(openEnd + 1, closing.bodyEnd), start, end: closing.end }
    }
    from = start + open.length
  }
}

export function stripFencedBlock(text: string, tag: string): string {
  const block = readFencedBlock(text, tag)
  if (block === null) return text
  return `${text.slice(0, block.start)}${text.slice(block.end)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
