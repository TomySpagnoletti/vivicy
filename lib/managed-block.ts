// Imported directly by factory/dev-loop.ts via a relative .ts path (no bundler) — this file must stay free of Next path aliases and any node:/Next-only import.
// `.gitignore` FIRST, and the order is load-bearing: it is the file that carries the never-commit rules, so writing it last would leave every other managed file's atomic-write temp uncovered on the pass that installs the block.
export const MANAGED_GOVERNANCE_FILES = [".gitignore", "AGENTS.md", "CLAUDE.md"] as const

export type ManagedGovernanceFile = (typeof MANAGED_GOVERNANCE_FILES)[number]

export interface MarkerPair {
  begin: string
  end: string
}

export const METHOD_MARKERS: MarkerPair = {
  begin: "<!-- vivicy:method:begin -->",
  end: "<!-- vivicy:method:end -->",
}

export const GITIGNORE_MARKERS: MarkerPair = {
  begin: "# --- vivicy managed block: essential ignores (do not edit) ---",
  end: "# --- end vivicy managed block ---",
}

export interface ManagedSpec {
  block: string
  template: string
  markers: MarkerPair
}

interface Line {
  start: number
  raw: string
}

type MarkerKind = "begin" | "end" | null

interface Scan {
  content: string
  lines: Line[]
  kinds: MarkerKind[]
}

function scan(content: string, markers: MarkerPair): Scan {
  const lines: Line[] = []
  let start = 0
  for (const raw of content.split("\n")) {
    lines.push({ start, raw })
    start += raw.length + 1
  }
  const kinds = lines.map(({ raw }) => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    return text === markers.begin ? "begin" : text === markers.end ? "end" : null
  })
  return { content, lines, kinds }
}

function soleSpan({ lines, kinds }: Scan): { start: number; end: number } | null {
  const begin = kinds.indexOf("begin")
  const end = kinds.indexOf("end")
  if (begin === -1 || end < begin) return null
  if (kinds.indexOf("begin", begin + 1) !== -1 || kinds.indexOf("end", end + 1) !== -1) return null
  return { start: lines[begin].start, end: lines[end].start + lines[end].raw.length }
}

// Vivicy owns exactly two things in an owner's file: a span whose markers are each other's NEAREST counterpart (an end pairs with the closest begin above it, NEVER across an intervening begin), and any marker LINE left unpaired. Everything else is the owner's, byte-preserved — pairing an end with an earlier begin would swallow, and delete, the owner lines sitting between the two begins.
function withoutManagedLines({ content, lines, kinds }: Scan): string {
  const drop = new Array<boolean>(lines.length).fill(false)
  let open = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (kinds[i] === null) continue
    if (kinds[i] === "begin") {
      if (open !== -1) drop[open] = true
      open = i
      continue
    }
    if (open === -1) {
      drop[i] = true
      continue
    }
    for (let j = open; j <= i; j += 1) drop[j] = true
    open = -1
  }
  if (open !== -1) drop[open] = true
  let out = ""
  for (let i = 0; i < lines.length; i += 1) {
    if (drop[i]) continue
    out += content.slice(lines[i].start, i + 1 < lines.length ? lines[i + 1].start : content.length)
  }
  return out
}

function appendBlock(current: string, block: string): string {
  const base = current.replace(/\n+$/, "")
  return base.length === 0 ? `${block}\n` : `${base}\n\n${block}\n`
}

export function extractManagedBlock(template: string, markers: MarkerPair): string {
  const span = soleSpan(scan(template, markers))
  if (!span) {
    throw new Error(`managed-block template must embed exactly one well-formed ${markers.begin} … ${markers.end} block`)
  }
  return template.slice(span.start, span.end)
}

// latin1 is Node's identity byte codec — one char per byte, every byte round-trips — so the scan and splice run over the owner's raw bytes: a latin-1, UTF-8 or BOM-carrying file is never decoded, never re-encoded, and everything outside the span comes back byte-identical.
const BYTEWISE = "latin1" as const

function asBytes(text: string): string {
  return Buffer.from(text, "utf8").toString(BYTEWISE)
}

export function ensureManagedBlock(current: Buffer | null, spec: ManagedSpec): Buffer {
  if (current === null) return Buffer.from(spec.template, "utf8")
  const content = current.toString(BYTEWISE)
  const block = asBytes(spec.block)
  const scanned = scan(content, { begin: asBytes(spec.markers.begin), end: asBytes(spec.markers.end) })
  const span = soleSpan(scanned)
  const next = span ? content.slice(0, span.start) + block + content.slice(span.end) : appendBlock(withoutManagedLines(scanned), block)
  return Buffer.from(next, BYTEWISE)
}
