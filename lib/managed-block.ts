// Server-only LEAF: loaded by the factory via relative `.ts` paths and by the Next app via `@/lib/managed-block`, so no Next alias, no relative value import, and no "use client" component may reach it.

import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

// `.gitignore` must stay FIRST: it carries the ignore rules covering every other managed file's atomic-write temp.
export const MANAGED_MARKDOWN_FILES = ["AGENTS.md", "CLAUDE.md"] as const
export const MANAGED_GOVERNANCE_FILES = [".gitignore", ...MANAGED_MARKDOWN_FILES] as const

// The managed ignore block excludes `<prefix>*` — move one and move the other, or an abandoned temp becomes committable.
export const MANAGED_TEMP_PREFIX = ".vivicy-tmp."

export type ManagedGovernanceFile = (typeof MANAGED_GOVERNANCE_FILES)[number]
export type ManagedMarkdownFile = (typeof MANAGED_MARKDOWN_FILES)[number]

export interface MarkerPair {
  begin: string
  end: string
}

export const METHOD_MARKERS: MarkerPair = {
  begin: "<!-- vivicy:method:begin -->",
  end: "<!-- vivicy:method:end -->",
}

export const SKILLS_MARKERS: MarkerPair = {
  begin: "<!-- vivicy:skills:begin -->",
  end: "<!-- vivicy:skills:end -->",
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

// An end pairs with the NEAREST begin above it, never across an intervening begin: the wider pairing deletes the owner's own lines between the two begins.
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

// latin1 is the identity byte codec: never switch it to utf8, or the owner's bytes stop round-tripping outside the span.
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

// Never use parameter properties here: they are not erasable syntax, and the factory program type-checks this module.
export class ManagedWriteError extends Error {
  readonly code: "unsupported_encoding"
  readonly detail: string

  constructor(message: string, code: "unsupported_encoding", detail: string) {
    super(message)
    this.name = "ManagedWriteError"
    this.code = code
    this.detail = detail
  }
}

// Longest BOM first: a UTF-32LE file opens on the UTF-16LE mark, so a reordering names the wrong encoding in the refusal.
const UNSUPPORTED_BOMS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["UTF-32BE", [0x00, 0x00, 0xfe, 0xff]],
  ["UTF-32LE", [0xff, 0xfe, 0x00, 0x00]],
  ["UTF-16BE", [0xfe, 0xff]],
  ["UTF-16LE", [0xff, 0xfe]],
]

function unsupportedEncoding(bytes: Buffer): string | null {
  for (const [name, bom] of UNSUPPORTED_BOMS) {
    if (bom.every((byte, i) => bytes[i] === byte)) return name
  }
  return null
}

function readManaged(abs: string): Buffer | null {
  try {
    return readFileSync(abs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

// The rename must land on the RESOLVED target, or it replaces an owner's `CLAUDE.md -> AGENTS.md` symlink with a regular file; every caller reasoning about which file a managed write touches resolves it HERE, never a second way.
export function resolvedManagedTarget(abs: string): string {
  let target = abs
  for (let hop = 0; hop < 32; hop += 1) {
    let link: string
    try {
      link = readlinkSync(target)
    } catch {
      return target
    }
    target = path.resolve(path.dirname(target), link)
  }
  return target
}

function syncDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, "r")
    fsyncSync(fd)
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// Never simplify this sequence: refuse a read-only target explicitly (a rename ignores its mode), keep the temp beside the resolved file, REMOVE a stale temp rather than open it, chmod the fd after the write (the umask masks a create mode), and fsync before the rename.
function replaceAtomically(abs: string, next: Buffer): void {
  const target = resolvedManagedTarget(abs)
  const existing = statSync(target, { throwIfNoEntry: false })
  if (existing) accessSync(target, constants.W_OK)
  const mode = existing ? existing.mode & 0o7777 : undefined
  const temp = path.join(path.dirname(target), `${MANAGED_TEMP_PREFIX}${process.pid}.${path.basename(target)}`)
  try {
    rmSync(temp, { force: true })
    const fd = openSync(temp, "wx", mode ?? 0o666)
    try {
      writeFileSync(fd, next)
      if (mode !== undefined) fchmodSync(fd, mode)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, target)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {}
    throw error
  }
  syncDirectory(path.dirname(target))
}

// `onWrite` fires only when the bytes DIFFER and always BEFORE they are published, carrying the resolved target: a crash between the record and the rename must leave the path committable, never dirty.
export function writeManaged(abs: string, spec: ManagedSpec, onWrite?: (published: string) => void): string | null {
  const current = readManaged(abs)
  const encoding = current && unsupportedEncoding(current)
  if (encoding) {
    const detail = `not UTF-8 — it is saved as ${encoding}, and Vivicy replaces a managed file byte for byte rather than re-encode yours; re-save it as UTF-8`
    throw new ManagedWriteError(`${path.basename(abs)} is ${detail}`, "unsupported_encoding", detail)
  }
  const next = ensureManagedBlock(current, spec)
  if (current && next.equals(current)) return null
  onWrite?.(resolvedManagedTarget(abs))
  mkdirSync(path.dirname(abs), { recursive: true })
  replaceAtomically(abs, next)
  return abs
}

export function managedWriteFailureReason(error: unknown, abs: string): string {
  if (error instanceof ManagedWriteError) return error.detail
  if (!(error instanceof Error)) return String(error)
  const { path: errorPath, syscall } = error as NodeJS.ErrnoException
  const ours = errorPath === abs || (errorPath ?? "").includes(MANAGED_TEMP_PREFIX)
  return ours && syscall ? error.message.split(`, ${syscall} `)[0] : error.message
}
