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

export type ManagedBlockCorruption =
  | "duplicate_begin_marker"
  | "duplicate_end_marker"
  | "unterminated_block"
  | "stray_end_marker"
  | "misordered_markers"

export class ManagedBlockError extends Error {
  constructor(
    message: string,
    readonly reason: ManagedBlockCorruption
  ) {
    super(message)
    this.name = "ManagedBlockError"
  }
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

function splitLines(content: string): Line[] {
  const out: Line[] = []
  let start = 0
  for (const raw of content.split("\n")) {
    out.push({ start, raw })
    start += raw.length + 1
  }
  return out
}

function markerLines(lines: Line[], marker: string): Line[] {
  return lines.filter((line) => (line.raw.endsWith("\r") ? line.raw.slice(0, -1) : line.raw) === marker)
}

function appendBlock(current: string, block: string): string {
  const base = current.replace(/\n+$/, "")
  return base.length === 0 ? `${block}\n` : `${base}\n\n${block}\n`
}

export function extractManagedBlock(template: string, markers: MarkerPair): string {
  const lines = splitLines(template)
  const begins = markerLines(lines, markers.begin)
  const ends = markerLines(lines, markers.end)
  if (begins.length !== 1 || ends.length !== 1 || ends[0].start < begins[0].start) {
    throw new Error(`managed-block template must embed exactly one well-formed ${markers.begin} … ${markers.end} block`)
  }
  return template.slice(begins[0].start, ends[0].start + ends[0].raw.length)
}

export function ensureManagedBlock(current: string | null, spec: ManagedSpec): string {
  if (current === null) return spec.template

  const lines = splitLines(current)
  const begins = markerLines(lines, spec.markers.begin)
  const ends = markerLines(lines, spec.markers.end)

  if (begins.length === 0 && ends.length === 0) return appendBlock(current, spec.block)

  if (begins.length > 1) {
    throw new ManagedBlockError("the managed block is corrupt: the begin marker appears more than once", "duplicate_begin_marker")
  }
  if (ends.length > 1) {
    throw new ManagedBlockError("the managed block is corrupt: the end marker appears more than once", "duplicate_end_marker")
  }
  if (begins.length === 1 && ends.length === 0) {
    throw new ManagedBlockError("the managed block is corrupt: a begin marker with no matching end marker", "unterminated_block")
  }
  if (begins.length === 0 && ends.length === 1) {
    throw new ManagedBlockError("the managed block is corrupt: an end marker with no matching begin marker", "stray_end_marker")
  }

  const begin = begins[0]
  const end = ends[0]
  if (end.start < begin.start) {
    throw new ManagedBlockError("the managed block is corrupt: the end marker precedes the begin marker", "misordered_markers")
  }

  const before = current.slice(0, begin.start)
  const after = current.slice(end.start + end.raw.length)
  return before + spec.block + after
}
