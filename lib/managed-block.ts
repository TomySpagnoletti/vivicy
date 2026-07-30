// Imported directly by factory/dev-loop.ts and factory/install-skills.ts via relative .ts paths (no bundler) AND by the Next app through `@/lib/managed-block`, so it must stay a LEAF: no Next path alias and no relative value import (an extensionless one fails NodeNext, a `.ts` one fails the app program's TS5097). It is server-only — the atomic writer below needs node:fs — so no "use client" component may reach it.

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

// Two CLIs read two documents, so every Vivicy-managed block lands in both; `.gitignore` comes FIRST and that order is load-bearing — it carries the never-commit rules, so writing it last would leave every other managed file's atomic-write temp uncovered on the pass that installs the block.
export const MANAGED_MARKDOWN_FILES = ["AGENTS.md", "CLAUDE.md"] as const
export const MANAGED_GOVERNANCE_FILES = [".gitignore", ...MANAGED_MARKDOWN_FILES] as const

// Basename prefix of every Vivicy artifact published by rename; the managed ignore block excludes `<prefix>*`, so a temp a crash abandoned is never committable.
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

// Parameter properties are not erasable syntax, and this module is type-checked by the factory program too.
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

// Longest BOM first: a UTF-32LE file opens on the UTF-16LE mark, so the shorter pattern would name the wrong encoding in a refusal the owner acts on. Markers and block are ASCII, so every ASCII-compatible encoding splices byte-safely and only these are refused.
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

// The rename must land on the RESOLVED file, or it would replace an owner's symlink (the `CLAUDE.md -> AGENTS.md` convention) with a regular file; a dangling link resolves to where it points, as a plain write did, and the hop bound makes a link cycle degrade instead of hang. Exported because a caller that must reason about WHICH file a managed write touches has to resolve it exactly as the write does — one resolution, never a second implementation.
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

// Every step here is load-bearing: a rename ignores the target's own mode, so a read-only file (or directory) must be refused EXPLICITLY; the temp sits beside the resolved file so the rename is one same-filesystem syscall under a name the managed ignore block covers; a stale temp is REMOVED, never opened, since a symlink left there would capture the write and a reused inode would carry its mode into the owner's file; the mode is applied to the fd AFTER the write because the umask masks a create mode; and the fsync precedes the rename, or a power loss leaves the name pointing at nothing.
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

// The single seam every managed-block writer reaches. `onWrite` fires once the bytes are known to DIFFER and before they are published, carrying the file the bytes will actually land in (the resolved symlink target) — the hook a caller needs to record the write causally, since a crash between the record and the rename must leave the path staged-and-committable rather than dirty.
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

// Node appends ", <syscall> '<path>'" to fs errors: dropped when that path is the file the announcement already names or Vivicy's own temp, kept otherwise — a failure on a Vivicy TEMPLATE would otherwise read as the owner's own file being gone.
export function managedWriteFailureReason(error: unknown, abs: string): string {
  if (error instanceof ManagedWriteError) return error.detail
  if (!(error instanceof Error)) return String(error)
  const { path: errorPath, syscall } = error as NodeJS.ErrnoException
  const ours = errorPath === abs || (errorPath ?? "").includes(MANAGED_TEMP_PREFIX)
  return ours && syscall ? error.message.split(`, ${syscall} `)[0] : error.message
}
