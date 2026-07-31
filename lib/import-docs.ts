import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { unzipSync } from "fflate"
import { franc } from "franc-min"

import { countForm, countOf } from "@/lib/count-form"
import { appendNotification } from "@/lib/notifications"
import { isGovernedRoot } from "@/lib/project"
import type { CurrentProject } from "@/lib/project-types"
import { deriveProjectName, resolveTargetDir, scaffoldProject, type ScaffoldMode } from "@/lib/scaffold"
import { dominantLanguage } from "@/lib/dominant-language"
import { activeCycleBinding, type BatchCycleBinding } from "@/lib/spec-cycle"
import { SUPPORTED_DOC_EXTENSIONS, ZIP_TRANSPORT_EXTENSION } from "@/lib/supported-extensions"
import { scanDocument, type SecretFileFinding } from "@/lib/secret-scan"
import { extractScannableText } from "@/lib/text-extract"

export const UPLOADS_DIR = path.join(".vivicy", "uploads")
export const MANIFEST_FILE = "manifest.json"

export const SUPPORTED_EXTENSIONS = new Set<string>(SUPPORTED_DOC_EXTENSIONS)

const ZIP_EXTENSION = ZIP_TRANSPORT_EXTENSION
const MAX_ZIP_DEPTH = 2
const UNDETERMINED_LANGUAGE = "und"

export type ImportErrorCode = "no_files" | "no_supported_files" | "already_governed" | "not_governed" | "zip_slip" | "zip_unreadable"

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
  cycle: BatchCycleBinding
  files: ManifestFile[]
}

export interface BatchResult {
  batchId: string
  targetPath: string
  language: string
  cycle: BatchCycleBinding
  accepted: ManifestFile[]
  rejected: RejectedFile[]
  findings: SecretFileFinding[]
}

export interface GovernanceResult {
  mode: ScaffoldMode
  project: CurrentProject
  batch: BatchResult | null
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
    throw new ImportError(`could not read zip: ${source} (${error instanceof Error ? error.message : "unreadable"})`, "zip_unreadable", {
      source,
    })
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

async function summarizeBatch(batchDir: string): Promise<{ files: ManifestFile[]; language: string; findings: SecretFileFinding[] }> {
  const files: ManifestFile[] = []
  const weights = new Map<string, number>()
  const findings: SecretFileFinding[] = []
  for (const abs of walkFiles(batchDir)) {
    const rel = toPosix(path.relative(batchDir, abs))
    if (rel === MANIFEST_FILE) continue
    const bytes = readFileSync(abs)
    files.push({ path: rel, size: bytes.length, sha256: sha256(bytes) })
    const text = await extractScannableText(extLower(rel), bytes)
    if (text.trim().length === 0) continue
    findings.push(...scanDocument(rel, text))
    const lang = franc(text)
    if (lang !== UNDETERMINED_LANGUAGE) weights.set(lang, (weights.get(lang) ?? 0) + text.length)
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return { files, language: dominantLanguage(weights), findings }
}

function secretFindingNotice(findings: SecretFileFinding[], batchId: string): string {
  const fileCount = new Set(findings.map((f) => f.path)).size
  return (
    `${countOf(findings.length, "possible secret key", "possible secret keys")} detected in ${countOf(fileCount, "file", "files")} of batch ${batchId}` +
    ` — remove or rotate ${countForm(findings.length, "it", "them")} and re-import before the workflow runs;` +
    ` ask Vivi for ${countForm(findings.length, "the exact location", "the exact locations")}`
  )
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

// Explode before any write: an all-unsupported batch must never scaffold or touch the target.
function explodeOrThrow(entries: RawEntry[]): { accepted: AcceptedEntry[]; rejected: RejectedFile[] } {
  const exploded = explode(entries)
  if (exploded.accepted.length === 0) {
    throw new ImportError("none of the uploaded files are a supported document type", "no_supported_files", { rejected: exploded.rejected })
  }
  return exploded
}

// Guard-less core: every caller must have already proved the root governed.
async function persistBatch(root: string, exploded: { accepted: AcceptedEntry[]; rejected: RejectedFile[] }): Promise<BatchResult> {
  const batchId = mintBatchId(root)
  const batchDir = path.join(root, UPLOADS_DIR, batchId)
  for (const file of exploded.accepted) writeBatchFile(batchDir, file.rel, file.bytes)

  const { files, language, findings } = await summarizeBatch(batchDir)
  const cycle = activeCycleBinding(root)
  const manifest: BatchManifest = {
    batchId,
    createdAt: new Date().toISOString(),
    language,
    cycle,
    files,
  }
  writeManifest(batchDir, manifest)

  if (findings.length > 0) {
    appendNotification({
      level: "warning",
      stage: "import",
      event: "secret_finding",
      message: secretFindingNotice(findings, batchId),
    })
  }

  return { batchId, targetPath: root, language, cycle, accepted: files, rejected: exploded.rejected, findings }
}

export async function startGovernance(input: {
  targetDir: unknown
  projectName?: unknown
  entries: RawEntry[]
}): Promise<GovernanceResult> {
  const { target } = resolveTargetDir(input.targetDir)
  if (isGovernedRoot(target)) {
    throw new ImportError(`this folder is already governed by Vivicy — importing would overwrite it: ${target}`, "already_governed")
  }

  const exploded = input.entries.length > 0 ? explodeOrThrow(input.entries) : null
  const projectName =
    typeof input.projectName === "string" && input.projectName.trim().length > 0 ? input.projectName : deriveProjectName(target)
  const scaffold = scaffoldProject({ targetDir: target, projectName })
  const batch = exploded ? await persistBatch(scaffold.project.root, exploded) : null
  return { mode: scaffold.mode, project: scaffold.project, batch }
}

export async function importIntoGoverned(input: { root: string; entries: RawEntry[] }): Promise<BatchResult> {
  if (!input.entries || input.entries.length === 0) {
    throw new ImportError("no files were uploaded", "no_files")
  }
  if (!isGovernedRoot(input.root)) {
    throw new ImportError(`this folder is not governed by Vivicy: no .vivicy directory in ${input.root}`, "not_governed")
  }
  return persistBatch(input.root, explodeOrThrow(input.entries))
}

// manifest.json is the batch-complete marker: it must stay the LAST write of an import.
function writeManifest(batchDir: string, manifest: BatchManifest): void {
  writeFileSync(path.join(batchDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
}
