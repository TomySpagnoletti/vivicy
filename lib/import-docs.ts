import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { unzipSync } from "fflate"
import { franc } from "franc-min"

import { appendNotification } from "@/lib/notifications"
import { isGovernedRoot } from "@/lib/project"
import type { CurrentProject } from "@/lib/project-types"
import { deriveProjectName, resolveTargetDir, scaffoldProject, type ScaffoldMode } from "@/lib/scaffold"

export const UPLOADS_DIR = path.join(".vivicy", "uploads")
export const MANIFEST_FILE = "manifest.json"

export const SUPPORTED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".rtf",
  ".docx",
  ".odt",
  ".pdf",
  ".html",
  ".htm",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".adoc",
  ".asciidoc",
  ".rst",
  ".tex",
  ".eml",
])

const TEXT_LANGUAGE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".htm",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".adoc",
  ".asciidoc",
  ".rst",
  ".tex",
  ".eml",
])

const ZIP_EXTENSION = ".zip"
const MAX_ZIP_DEPTH = 2
const UNDETERMINED_LANGUAGE = "und"

export type ImportErrorCode =
  | "no_files"
  | "no_supported_files"
  | "already_governed"
  | "zip_slip"
  | "zip_unreadable"

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: ImportErrorCode,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = "ImportError"
  }
}

export interface RawEntry {
  rel: string
  name: string
  bytes: Uint8Array
}

export interface ManifestFile {
  path: string
  size: number
  sha256: string
}

export interface RejectedFile {
  path: string
  code: "unsupported_type"
}

export interface BatchManifest {
  batchId: string
  createdAt: string
  language: string
  files: ManifestFile[]
}

export interface ImportResult {
  batchId: string
  targetPath: string
  language: string
  accepted: ManifestFile[]
  rejected: RejectedFile[]
  mode: ScaffoldMode
  project: CurrentProject
}

interface AcceptedEntry {
  rel: string
  bytes: Uint8Array
}

function extLower(rel: string): string {
  return path.extname(rel).toLowerCase()
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/")
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function safeRel(rel: string, name: string): string {
  const candidate = (rel && rel.length > 0 ? rel : name).replace(/\\/g, "/")
  const normalized = path
    .normalize(candidate)
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
    .join("/")
  return normalized.length > 0 ? normalized : path.basename(name)
}

function zipEntryRel(innerPath: string): string {
  const normalized = innerPath.replace(/\\/g, "/")
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new ImportError(`zip entry escapes the batch: ${innerPath}`, "zip_slip", { entry: innerPath })
  }
  const segments = normalized.split("/")
  if (segments.some((seg) => seg === "..")) {
    throw new ImportError(`zip entry escapes the batch: ${innerPath}`, "zip_slip", { entry: innerPath })
  }
  return segments.filter((seg) => seg.length > 0 && seg !== ".").join("/")
}

function unzip(bytes: Uint8Array, source: string): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes)
  } catch (error) {
    throw new ImportError(
      `could not read zip: ${source} (${error instanceof Error ? error.message : "unreadable"})`,
      "zip_unreadable",
      { source }
    )
  }
}

function explode(entries: RawEntry[]): { accepted: AcceptedEntry[]; rejected: RejectedFile[] } {
  const accepted: AcceptedEntry[] = []
  const rejected: RejectedFile[] = []

  const walk = (rel: string, bytes: Uint8Array, depth: number): void => {
    if (extLower(rel) === ZIP_EXTENSION) {
      if (depth >= MAX_ZIP_DEPTH) {
        rejected.push({ path: rel, code: "unsupported_type" })
        return
      }
      const parent = path.posix.dirname(rel)
      const inner = unzip(bytes, rel)
      for (const [innerPath, innerBytes] of Object.entries(inner)) {
        if (innerPath.endsWith("/") || innerBytes.length === 0) continue
        const childRel = zipEntryRel(innerPath)
        if (childRel.length === 0) continue
        walk(parent === "." ? childRel : path.posix.join(parent, childRel), innerBytes, depth + 1)
      }
      return
    }
    if (SUPPORTED_EXTENSIONS.has(extLower(rel))) accepted.push({ rel, bytes })
    else rejected.push({ path: rel, code: "unsupported_type" })
  }

  for (const entry of entries) {
    walk(safeRel(entry.rel, entry.name), entry.bytes, 0)
  }
  return {
    accepted,
    rejected: rejected.sort((a, b) => a.path.localeCompare(b.path)),
  }
}

export function dominantLanguage(weights: Map<string, number>): string {
  if (weights.size === 0) return UNDETERMINED_LANGUAGE
  let best = UNDETERMINED_LANGUAGE
  let bestWeight = -1
  for (const [lang, weight] of [...weights.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (weight > bestWeight) {
      best = lang
      bestWeight = weight
    }
  }
  return best
}

function walkFiles(dir: string): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(abs)
      else if (entry.isFile()) out.push(abs)
    }
  }
  return out
}

function summarizeBatch(batchDir: string): { files: ManifestFile[]; language: string } {
  const files: ManifestFile[] = []
  const weights = new Map<string, number>()
  for (const abs of walkFiles(batchDir)) {
    const rel = toPosix(path.relative(batchDir, abs))
    if (rel === MANIFEST_FILE) continue
    const bytes = readFileSync(abs)
    files.push({ path: rel, size: bytes.length, sha256: sha256(bytes) })
    if (TEXT_LANGUAGE_EXTENSIONS.has(extLower(rel))) {
      const lang = franc(bytes.toString("utf8"))
      weights.set(lang, (weights.get(lang) ?? 0) + bytes.length)
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, language: dominantLanguage(weights) }
}

export function mintBatchId(root: string): string {
  const base = new Date().toISOString().replace(/[:.]/g, "-")
  const uploadsDir = path.join(root, UPLOADS_DIR)
  mkdirSync(uploadsDir, { recursive: true })
  let candidate = base
  let suffix = 1
  for (;;) {
    try {
      mkdirSync(path.join(uploadsDir, candidate))
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      suffix += 1
      candidate = `${base}-${suffix}`
    }
  }
}

function writeBatchFile(batchDir: string, rel: string, bytes: Uint8Array): void {
  const abs = path.join(batchDir, ...rel.split("/"))
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
}

export function importDocuments(input: { targetDir: unknown; entries: RawEntry[] }): ImportResult {
  if (!input.entries || input.entries.length === 0) {
    throw new ImportError("no files were uploaded", "no_files")
  }

  const { target } = resolveTargetDir(input.targetDir)
  if (isGovernedRoot(target)) {
    throw new ImportError(
      `this folder is already governed by Vivicy — importing would overwrite it: ${target}`,
      "already_governed"
    )
  }

  const { accepted, rejected } = explode(input.entries)
  if (accepted.length === 0) {
    throw new ImportError(
      "none of the uploaded files are a supported document type",
      "no_supported_files",
      { rejected }
    )
  }

  const scaffold = scaffoldProject({ targetDir: target, projectName: deriveProjectName(target) })
  const root = scaffold.project.root
  const batchId = mintBatchId(root)
  const batchDir = path.join(root, UPLOADS_DIR, batchId)
  for (const file of accepted) writeBatchFile(batchDir, file.rel, file.bytes)

  const { files, language } = summarizeBatch(batchDir)
  const manifest: BatchManifest = {
    batchId,
    createdAt: new Date().toISOString(),
    language,
    files,
  }
  writeManifest(batchDir, manifest)

  appendNotification({
    level: "info",
    stage: "import",
    event: "batch",
    message: `imported ${files.length} file(s) as batch ${batchId} (language: ${language})`,
  })

  return {
    batchId,
    targetPath: root,
    language,
    accepted: files,
    rejected,
    mode: scaffold.mode,
    project: scaffold.project,
  }
}

// manifest.json is the batch-complete marker: it is the LAST write of an import, so a batch dir lacking it is an interrupted, non-consumable batch the pipeline must skip.
function writeManifest(batchDir: string, manifest: BatchManifest): void {
  writeFileSync(path.join(batchDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
}
