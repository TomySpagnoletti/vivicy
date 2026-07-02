/**
 * Server-only S1-import engine (G1): stage an external doc upload, verify it
 * (check-then-place), then place the normalized corpus into `.vivicy/`. `node:fs`
 * and the OS converters (`ditto`/`unzip`/`textutil`) live here so they never reach
 * the client bundle; the agent CHECK lives in {@link file://./control} (runUploadVerify),
 * driven through the same injectable Spawner the rest of the control plane uses.
 *
 * The flow is three deterministic passes plus one agent leg:
 *   1. STAGE   (stageUpload)   — write raw files under <staging>/raw/, expand zips,
 *                                classify each into canonical|spike|map|unknown.
 *   2. NORMALIZE (normalizeStaging) — copy raw -> <staging>/normalized/ as MD,
 *                                converting .txt/.doc/.docx; map files verbatim.
 *   3. CHECK   (runUploadVerify, in control.ts) — one agent leg reads normalized/
 *                                and writes report.json { verdict, problems, summary }.
 *   4. PLACE   (applyUpload)   — refuse unless report.json is green; check ALL then
 *                                place ALL (never a partial placement) into .vivicy/.
 *
 * The impure OS seams (zip expansion, doc conversion) are injected so tests run
 * without darwin-only tools; production wires the real {@link expandZip} /
 * {@link convertDoc}.
 */

import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import { getRuntimeDir } from "@/lib/runtime-dir"

/** Typed reasons an upload request is rejected (so routes never invent prose). */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly code:
      | "no_files"
      | "unsupported_type"
      | "zip_unsupported"
      | "bad_staging"
      | "not_verified"
      | "would_overwrite",
    /** Extra structured payload the route echoes (e.g. the colliding paths). */
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = "UploadError"
  }
}

/** What kind of `.vivicy` artifact a staged file is routed to. */
export type UploadKind = "canonical" | "spike" | "map" | "unknown"

/** A file placed into the staging `raw/` set, with its classification. */
export interface StagedFile {
  /** The file's basename. */
  name: string
  /** Path relative to `raw/` (preserves the uploaded folder structure). */
  rel: string
  bytes: number
  kind: UploadKind
}

/** Result of {@link stageUpload}: the staging id + the classified raw set. */
export interface StageResult {
  stagingId: string
  staged: StagedFile[]
}

/** One file the normalization pass emitted (or failed to). */
export interface NormalizedFile {
  /** Source path relative to `raw/`. */
  from: string
  /** Destination path relative to `normalized/` (empty when the file was excluded). */
  to: string
  kind: UploadKind
}

/** A normalization problem (a conversion that could not run). */
export interface NormalizationProblem {
  file: string
  kind: "conversion_unavailable"
  detail: string
}

/** Result of {@link normalizeStaging}: the emitted set + any per-file problems. */
export interface NormalizeResult {
  normalized: NormalizedFile[]
  problems: NormalizationProblem[]
}

/** The report the agent CHECK leg writes to `<staging>/report.json`. */
export interface UploadReport {
  verdict: "green" | "red"
  problems: Array<{ file: string; kind: string; detail: string }>
  summary: string
}

/** One file {@link applyUpload} placed into the target `.vivicy/`. */
export interface PlacedFile {
  /** Destination path relative to the target root. */
  to: string
  kind: UploadKind
}

/** The extensions accepted at upload; everything else is refused up front. */
const ACCEPTED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".doc",
  ".docx",
  ".yml",
  ".yaml",
  ".zip",
])

/** Extensions that normalize straight to a canonical `.md` doc. */
const CANONICAL_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".doc", ".docx"])

/** A map YAML whose content declares nodes or a kind taxonomy is an architecture map. */
const MAP_CONTENT_RE = /^nodes:/m
const MAP_TAXONOMY_RE = /\bkind_taxonomy\b/

/**
 * Injection seam for zip expansion. The real implementation shells out to
 * `ditto`/`unzip`; tests inject a fake so they never depend on a darwin tool.
 * Must expand `zipPath` into `destDir` (which already exists), returning true on
 * success. A false return (or a throw) surfaces as {@link UploadError} "zip_unsupported".
 */
export type ZipExpander = (zipPath: string, destDir: string) => boolean

/**
 * Injection seam for `.doc`/`.docx` -> plain text conversion. The real
 * implementation shells out to `textutil` (darwin only); tests inject a fake.
 * Returns the converted UTF-8 text, or null when conversion is unavailable/failed
 * (then the file is reported "conversion_unavailable" and excluded, never guessed).
 */
export type DocConverter = (docPath: string) => string | null

/** The absolute staging root for a staging id: `<runtimeDir>/uploads/<id>`. */
export function getStagingDir(stagingId: string): string {
  return path.join(getRuntimeDir(), "uploads", stagingId)
}

/** `<staging>/raw` — where the uploaded (and zip-expanded) files land verbatim. */
export function getRawDir(stagingId: string): string {
  return path.join(getStagingDir(stagingId), "raw")
}

/** `<staging>/normalized` — the MD-normalized corpus the agent CHECK reads. */
export function getNormalizedDir(stagingId: string): string {
  return path.join(getStagingDir(stagingId), "normalized")
}

/** `<staging>/report.json` — the agent CHECK verdict (the gate `applyUpload` enforces). */
export function getReportPath(stagingId: string): string {
  return path.join(getStagingDir(stagingId), "report.json")
}

/**
 * Assert a staging id names a real staging dir with a `raw/` set, or throw
 * {@link UploadError} "bad_staging". A missing id (a stale/forged one) must never
 * be silently treated as an empty upload.
 */
function assertStaging(stagingId: string): string {
  const raw = getRawDir(stagingId)
  if (typeof stagingId !== "string" || stagingId.length === 0 || !existsSync(raw)) {
    throw new UploadError(`unknown staging id: ${stagingId || "(empty)"}`, "bad_staging")
  }
  return raw
}

/**
 * Real zip expander: `ditto -x -k` on darwin (preserves the archive's directory
 * structure the client encoded), `unzip -o` elsewhere. Returns true on a clean
 * expansion; false when neither tool is present or the expansion fails, so the
 * caller raises "zip_unsupported" rather than proceeding with a half-expanded set.
 */
export const expandZip: ZipExpander = (zipPath, destDir) => {
  const [command, args] =
    process.platform === "darwin"
      ? ["ditto", ["-x", "-k", zipPath, destDir]]
      : ["unzip", ["-o", zipPath, "-d", destDir]]
  try {
    const r = spawnSync(command as string, args as string[], { encoding: "utf8" })
    return r.status === 0
  } catch {
    return false
  }
}

/**
 * Real `.doc`/`.docx` converter: `textutil -convert txt` (darwin only) writing to
 * a sibling `.txt`, whose content is read back. Returns null on non-darwin or any
 * `textutil` failure — the caller then reports "conversion_unavailable" and
 * excludes the file, never fabricating its text.
 */
export const convertDoc: DocConverter = (docPath) => {
  if (process.platform !== "darwin") return null
  const outPath = `${docPath}.converted.txt`
  try {
    const r = spawnSync("textutil", ["-convert", "txt", "-output", outPath, docPath], {
      encoding: "utf8",
    })
    if (r.status !== 0 || !existsSync(outPath)) return null
    return readFileSync(outPath, "utf8")
  } catch {
    return null
  }
}

/** Every `.ext` we accept — the check the route runs before staging anything. */
export function isAcceptedFilename(name: string): boolean {
  return ACCEPTED_EXTENSIONS.has(path.extname(name).toLowerCase())
}

/**
 * Classify a staged file into its `.vivicy` destination kind, deterministically:
 *   - any path segment containing "spike" (case-insensitive) -> spike;
 *   - a `.yml`/`.yaml` whose content declares nodes / a kind taxonomy -> map;
 *   - a `.md`/`.markdown`/`.txt`/`.doc`/`.docx` -> canonical;
 *   - anything else -> unknown.
 * `rel` is the path relative to `raw/` (so the spike segment test sees folders);
 * `readContent` yields the file text lazily (only map candidates are read).
 */
export function classify(rel: string, readContent: () => string): UploadKind {
  const segments = rel.split(/[\\/]/)
  if (segments.some((segment) => /spike/i.test(segment))) return "spike"
  const ext = path.extname(rel).toLowerCase()
  if (ext === ".yml" || ext === ".yaml") {
    const content = readContent()
    return MAP_CONTENT_RE.test(content) || MAP_TAXONOMY_RE.test(content) ? "map" : "unknown"
  }
  if (CANONICAL_EXTENSIONS.has(ext)) return "canonical"
  return "unknown"
}

/** A single uploaded entry: its intended relative path and its raw bytes. */
export interface UploadEntry {
  /** The relative path the client preserved (""/absent for a bare file). */
  rel: string
  /** The upload's original filename (used when `rel` is empty). */
  name: string
  bytes: Uint8Array
}

/** Sanitize a client-supplied relative path so it can never escape `raw/`. */
function safeRel(rel: string, name: string): string {
  const candidate = (rel && rel.length > 0 ? rel : name).replace(/\\/g, "/")
  const normalized = path
    .normalize(candidate)
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
    .join("/")
  return normalized.length > 0 ? normalized : path.basename(name)
}

/**
 * STAGE an upload: write every entry under `<staging>/raw/` preserving its
 * relative path, expand any `.zip` in place into `raw/`, then classify the full
 * resulting file set. A fresh `stagingId` is minted per call. Refuses an empty
 * upload ("no_files") and any entry whose extension is not accepted
 * ("unsupported_type"). A `.zip` that neither `ditto` nor `unzip` can expand is
 * "zip_unsupported". `expander` is injected so tests never touch a darwin tool.
 */
export function stageUpload(
  entries: UploadEntry[],
  expander: ZipExpander = expandZip
): StageResult {
  if (!entries || entries.length === 0) {
    throw new UploadError("no files were uploaded", "no_files")
  }
  for (const entry of entries) {
    if (!isAcceptedFilename(entry.rel || entry.name)) {
      throw new UploadError(
        `unsupported file type: ${entry.rel || entry.name}`,
        "unsupported_type"
      )
    }
  }

  const stagingId = crypto.randomUUID()
  const rawDir = getRawDir(stagingId)
  mkdirSync(rawDir, { recursive: true })

  for (const entry of entries) {
    const rel = safeRel(entry.rel, entry.name)
    const abs = path.join(rawDir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, entry.bytes)
    if (path.extname(rel).toLowerCase() === ".zip") {
      if (!expander(abs, path.dirname(abs))) {
        throw new UploadError(`could not expand zip: ${rel}`, "zip_unsupported")
      }
    }
  }

  return { stagingId, staged: scanRaw(stagingId) }
}

/** Walk `raw/`, classifying every file (zip archives themselves are excluded). */
function scanRaw(stagingId: string): StagedFile[] {
  const rawDir = getRawDir(stagingId)
  const staged: StagedFile[] = []
  for (const abs of walkFiles(rawDir)) {
    const rel = path.relative(rawDir, abs)
    if (path.extname(rel).toLowerCase() === ".zip") continue
    staged.push({
      name: path.basename(rel),
      rel,
      bytes: statSync(abs).size,
      kind: classify(rel, () => readFileSync(abs, "utf8")),
    })
  }
  return staged.sort((a, b) => a.rel.localeCompare(b.rel))
}

/** Depth-first list of every file under `dir` (absolute paths), dirs excluded. */
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

/**
 * NORMALIZE a staged upload into `<staging>/normalized/`, preserving relative
 * structure. `.md`/`.markdown` copy as-is; `.txt` copies with a `.md` extension;
 * `.doc`/`.docx` convert via `converter` then write `.md` — a conversion that
 * cannot run yields a per-file "conversion_unavailable" problem and excludes the
 * file (normalization CONTINUES). Map files copy verbatim (keeping their `.yml`).
 * Unknown files are excluded (never placed). `converter` is injected so tests run
 * without `textutil`.
 */
export function normalizeStaging(
  stagingId: string,
  converter: DocConverter = convertDoc
): NormalizeResult {
  assertStaging(stagingId)
  const rawDir = getRawDir(stagingId)
  const normalizedDir = getNormalizedDir(stagingId)
  const normalized: NormalizedFile[] = []
  const problems: NormalizationProblem[] = []

  for (const staged of scanRaw(stagingId)) {
    const fromAbs = path.join(rawDir, staged.rel)
    const ext = path.extname(staged.rel).toLowerCase()

    if (staged.kind === "unknown") continue

    if (staged.kind === "map") {
      const to = staged.rel
      writeNormalized(normalizedDir, to, readFileSync(fromAbs))
      normalized.push({ from: staged.rel, to, kind: "map" })
      continue
    }

    // canonical | spike, all normalized to MD.
    if (ext === ".md" || ext === ".markdown") {
      const to = toMarkdownRel(staged.rel)
      writeNormalized(normalizedDir, to, readFileSync(fromAbs))
      normalized.push({ from: staged.rel, to, kind: staged.kind })
    } else if (ext === ".txt") {
      const to = toMarkdownRel(staged.rel)
      writeNormalized(normalizedDir, to, readFileSync(fromAbs))
      normalized.push({ from: staged.rel, to, kind: staged.kind })
    } else {
      // .doc / .docx — needs conversion.
      const text = converter(fromAbs)
      if (text === null) {
        problems.push({
          file: staged.rel,
          kind: "conversion_unavailable",
          detail: `could not convert ${ext} to text (textutil unavailable or failed); file excluded from the normalized set`,
        })
        continue
      }
      const to = toMarkdownRel(staged.rel)
      writeNormalized(normalizedDir, to, text)
      normalized.push({ from: staged.rel, to, kind: staged.kind })
    }
  }

  return { normalized, problems }
}

/** Rewrite a relative path's extension to `.md` (for .txt/.doc/.docx/.markdown). */
function toMarkdownRel(rel: string): string {
  const ext = path.extname(rel)
  return ext ? `${rel.slice(0, -ext.length)}.md` : `${rel}.md`
}

/** Write `contents` under `normalized/`, creating parent dirs. */
function writeNormalized(normalizedDir: string, rel: string, contents: string | Uint8Array): void {
  const abs = path.join(normalizedDir, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, contents)
}

/** Read the agent CHECK report, or null when it is missing/unparseable. */
export function readReport(stagingId: string): UploadReport | null {
  const file = getReportPath(stagingId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as UploadReport
  } catch {
    return null
  }
}

/**
 * The target-root destination for a normalized file of a given kind:
 *   - canonical -> `.vivicy/canonical/<basename>`
 *   - spike     -> `.vivicy/development/spikes/<basename>`
 *   - map       -> `.vivicy/architecture-map/architecture-map.yml`
 * Unknown never has a destination (it is excluded before placement).
 */
function destinationFor(normalizedRel: string, kind: UploadKind): string | null {
  const base = path.basename(normalizedRel)
  switch (kind) {
    case "canonical":
      return path.join(".vivicy", "canonical", base)
    case "spike":
      return path.join(".vivicy", "development", "spikes", base)
    case "map":
      return path.join(".vivicy", "architecture-map", "architecture-map.yml")
    default:
      return null
  }
}

/**
 * PLACE a verified upload into `targetRoot`'s `.vivicy/`. Refuses unless
 * `report.json` exists with `verdict: "green"` ("not_verified"). Places
 * canonical/spike/map files at their contract destinations, and NEVER overwrites
 * an existing target file: it checks ALL destinations first and, if ANY already
 * exists, throws {@link UploadError} "would_overwrite" listing the collisions
 * BEFORE writing anything (check-all-then-place-all — no partial placement).
 */
export function applyUpload(stagingId: string, targetRoot: string): { placed: PlacedFile[] } {
  assertStaging(stagingId)
  const report = readReport(stagingId)
  if (!report || report.verdict !== "green") {
    throw new UploadError(
      report ? `upload verdict is "${report.verdict}", not green` : "no verification report — run verify first",
      "not_verified"
    )
  }

  const normalizedDir = getNormalizedDir(stagingId)
  // Resolve every (source, destination) pair up front so we can check ALL
  // destinations before writing ANY of them.
  const plan: Array<{ fromAbs: string; toRel: string; kind: UploadKind }> = []
  for (const abs of walkFiles(normalizedDir)) {
    const rel = path.relative(normalizedDir, abs)
    const kind = classify(rel, () => readFileSync(abs, "utf8"))
    const toRel = destinationFor(rel, kind)
    if (toRel === null) continue
    plan.push({ fromAbs: abs, toRel, kind })
  }

  // Collisions come in two flavors, both fatal before ANY write: a destination
  // already present in the target, and two staged files flattening to the SAME
  // destination (e.g. spikes with one basename in different subdirs) — the second
  // would silently overwrite the first mid-placement.
  const seen = new Map<string, string>()
  const collisions: string[] = []
  for (const item of plan) {
    if (existsSync(path.join(targetRoot, item.toRel))) collisions.push(item.toRel)
    const prior = seen.get(item.toRel)
    if (prior !== undefined) collisions.push(`${item.toRel} (staged twice: ${prior} and ${path.relative(normalizedDir, item.fromAbs)})`)
    else seen.set(item.toRel, path.relative(normalizedDir, item.fromAbs))
  }
  if (collisions.length > 0) {
    throw new UploadError(
      `refusing to overwrite existing file(s): ${collisions.join(", ")}`,
      "would_overwrite",
      { collisions }
    )
  }

  const placed: PlacedFile[] = []
  for (const item of plan) {
    const destAbs = path.join(targetRoot, item.toRel)
    mkdirSync(path.dirname(destAbs), { recursive: true })
    // Re-check at write time: the up-front pass can race an external writer, and
    // silent overwrite is the one forbidden outcome.
    if (existsSync(destAbs)) {
      throw new UploadError(`destination appeared during placement: ${item.toRel}`, "would_overwrite", {
        collisions: [item.toRel],
      })
    }
    copyFileSync(item.fromAbs, destAbs)
    placed.push({ to: item.toRel, kind: item.kind })
  }
  return { placed: placed.sort((a, b) => a.to.localeCompare(b.to)) }
}
