// Never rewrite this line scan as a /```tag\s*\n([\s\S]*?)\n\s*```/ regex: it backtracks catastrophically on the unclosed fence an uncapped agent reply can carry.
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
      // Refuse here, never advance: no later occurrence can close what this one could not, and rescanning the tail per occurrence is quadratic.
      if (closing === null) return null
      return { body: text.slice(openEnd + 1, closing.bodyEnd), start, end: closing.end }
    }
    from = start + open.length
  }
}

export function stripFencedBlock(text: string, tag: string): string {
  const block = readFencedBlock(text, tag)
  if (block === null) return text
  return `${text.slice(0, block.start)}${text.slice(block.end)}`.replace(/\n{3,}/g, "\n\n").trim()
}
