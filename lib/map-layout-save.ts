/**
 * Server-only layout-save for the architecture map.
 *
 * Faithful port of the original viewer's layout-save middleware
 * (`docs/architecture-map/viewer/vite.config.ts`): it patches the SOURCE
 * `architecture-map.yml` of the resolved TARGET project in place — rewriting each
 * dirty node's `layout_x`/`layout_y` and each dirty edge's `layout_label_ratio` —
 * then regenerates the served `architecture-data.json` so a reload reflects the
 * saved positions.
 *
 * Layers that keep the source map (the source of truth) from being mutated by
 * accident or corruption:
 *   1. the UI edit-mode toggle (the everyday gate): drag + Save only exist when
 *      the user opts in — read-only pan/select by default;
 *   2. an operator kill-switch: setting `VIVICY_MAP_LAYOUT_WRITE` to a falsey
 *      value (0/false/no/off) hard-locks this endpoint to read-only regardless of
 *      the UI, mirroring the old viewer's server-side write gate (a frozen map
 *      can refuse all writes). It defaults to enabled so the toggle drives saves;
 *   3. this module's integrity guards: every patch is validated against the
 *      on-disk map (node ids and exact edge identity must match), the target path
 *      is resolved through a fixed in-repo relative path with a traversal guard,
 *      and a failed regeneration rolls the source file back to its pre-save bytes.
 *
 * The YAML is edited line-by-line (never re-serialized) so untouched content is
 * preserved byte-for-byte; edge identity is read from the same line records, so
 * this module never has to import the generator's module-level side effects.
 */

import { execFile } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { getFactoryRoot } from "@/lib/control"
import { getTargetRoot } from "@/lib/target"

/** A dirty node's new committed coordinates. */
export interface NodeLayoutPatch {
  id: string
  layout_x: number
  layout_y: number
}

/** A dirty edge label's new position ratio, with its identity for verification. */
export interface EdgeLabelLayoutPatch {
  index: number
  from: string
  to: string
  relation: string
  protocol: string
  layout_label_ratio: number
}

/** The POST body the viewer sends when saving an edited layout. */
export interface LayoutSavePayload {
  nodes: NodeLayoutPatch[]
  edgeLabels: EdgeLabelLayoutPatch[]
}

/** Why a layout save failed (typed so the route never invents prose). */
export type LayoutSaveErrorCode =
  | "read_only"
  | "no_target"
  | "no_map"
  | "invalid_payload"
  | "patch_failed"
  | "regen_failed"

export class LayoutSaveError extends Error {
  constructor(
    message: string,
    readonly code: LayoutSaveErrorCode
  ) {
    super(message)
    this.name = "LayoutSaveError"
  }
}

/** The committed architecture map, relative to the target project root. */
export const MAP_RELATIVE_PATH = "docs/architecture-map/architecture-map.yml"

/** When an edge label sits at the midpoint we drop the key (it is the default). */
const DEFAULT_LABEL_RATIO = 0.5

interface YamlRecord {
  start: number
  end: number
  values: Record<string, string>
  keyLines: Map<string, number>
}

// --------------------------------------------------------------------------
// Payload validation (ported from the original middleware).
// --------------------------------------------------------------------------

export function validateLayoutSavePayload(input: unknown): LayoutSavePayload {
  if (!isRecord(input) || !Array.isArray(input.nodes) || !Array.isArray(input.edgeLabels)) {
    throw new LayoutSaveError(
      "Layout save payload must define nodes and edgeLabels arrays.",
      "invalid_payload"
    )
  }
  return {
    nodes: input.nodes.map(validateNodeLayoutPatch),
    edgeLabels: input.edgeLabels.map(validateEdgeLabelLayoutPatch),
  }
}

function validateNodeLayoutPatch(input: unknown): NodeLayoutPatch {
  if (
    !isRecord(input) ||
    typeof input.id !== "string" ||
    !Number.isFinite(input.layout_x) ||
    !Number.isFinite(input.layout_y)
  ) {
    throw new LayoutSaveError(
      "Every node layout patch must define id, layout_x, and layout_y.",
      "invalid_payload"
    )
  }
  return {
    id: input.id,
    layout_x: Number(input.layout_x),
    layout_y: Number(input.layout_y),
  }
}

function validateEdgeLabelLayoutPatch(input: unknown): EdgeLabelLayoutPatch {
  if (
    !isRecord(input) ||
    !Number.isInteger(input.index) ||
    typeof input.from !== "string" ||
    typeof input.to !== "string" ||
    typeof input.relation !== "string" ||
    typeof input.protocol !== "string" ||
    !Number.isFinite(input.layout_label_ratio)
  ) {
    throw new LayoutSaveError(
      "Every edge label patch must define index, endpoints, relation, protocol, and layout_label_ratio.",
      "invalid_payload"
    )
  }
  const layoutLabelRatio = Number(input.layout_label_ratio)
  if (layoutLabelRatio < 0 || layoutLabelRatio > 1) {
    throw new LayoutSaveError("Edge label ratio must be between 0 and 1.", "invalid_payload")
  }
  return {
    index: Number(input.index),
    from: input.from,
    to: input.to,
    relation: input.relation,
    protocol: input.protocol,
    layout_label_ratio: layoutLabelRatio,
  }
}

// --------------------------------------------------------------------------
// Pure YAML patching (ported from the original middleware; edge identity is read
// from the line records, so no generator import is required).
// --------------------------------------------------------------------------

/**
 * Validate the patch against the on-disk map, then apply it, returning the new
 * source. Pure (string in, string out) so it can be exercised directly.
 */
export function patchArchitectureMapLayout(source: string, payload: LayoutSavePayload): string {
  assertPatchTargets(source, payload)
  return applyLayoutPatch(source, payload)
}

function assertPatchTargets(source: string, payload: LayoutSavePayload): void {
  const lines = source.split(/\r?\n/)
  const nodeRecords = getYamlRecords(lines, "nodes")
  const edgeRecords = getYamlRecords(lines, "edges")
  const nodeRecordIds = new Set(nodeRecords.map((record) => unquoteYamlValue(record.values.id)))
  const seenNodeIds = new Set<string>()
  const seenEdgeIndexes = new Set<number>()

  for (const patch of payload.nodes) {
    if (seenNodeIds.has(patch.id)) {
      throw new LayoutSaveError(`Duplicate node layout patch: ${patch.id}`, "patch_failed")
    }
    seenNodeIds.add(patch.id)
    if (!nodeRecordIds.has(patch.id)) {
      throw new LayoutSaveError(`Unknown node layout patch: ${patch.id}`, "patch_failed")
    }
  }

  for (const patch of payload.edgeLabels) {
    if (seenEdgeIndexes.has(patch.index)) {
      throw new LayoutSaveError(`Duplicate edge label patch index: ${patch.index}`, "patch_failed")
    }
    seenEdgeIndexes.add(patch.index)
    const record = edgeRecords[patch.index]
    if (!record) {
      throw new LayoutSaveError(`Unknown edge label patch index: ${patch.index}`, "patch_failed")
    }
    assertSameEdge(patch.index, record, patch)
  }
}

function applyLayoutPatch(source: string, payload: LayoutSavePayload): string {
  const lines = source.split(/\r?\n/)
  const nodePatches = new Map(payload.nodes.map((node) => [node.id, node]))
  const edgeLabelPatches = new Map(payload.edgeLabels.map((edge) => [edge.index, edge]))
  const patchedNodeIds = new Set<string>()

  for (const record of getYamlRecords(lines, "nodes")) {
    const nodeId = unquoteYamlValue(record.values.id)
    const patch = nodePatches.get(nodeId)
    if (!patch) continue
    replaceRecordValue(lines, record, "layout_x", formatNumber(patch.layout_x))
    replaceRecordValue(lines, record, "layout_y", formatNumber(patch.layout_y))
    patchedNodeIds.add(nodeId)
  }
  if (patchedNodeIds.size !== nodePatches.size) {
    const missing = [...nodePatches.keys()].filter((id) => !patchedNodeIds.has(id))
    throw new LayoutSaveError(
      `Cannot save layout: node records were not patched: ${missing.join(", ")}`,
      "patch_failed"
    )
  }

  // Edge records are re-read after the in-place node patches (which never change
  // the line count). Iterate in reverse so a splice only shifts lines belonging
  // to already-processed records, keeping earlier records' line indices valid.
  const edgeRecords = getYamlRecords(lines, "edges")
  for (let index = edgeRecords.length - 1; index >= 0; index -= 1) {
    const record = edgeRecords[index]
    const patch = edgeLabelPatches.get(index)
    if (!patch) continue
    assertSameEdge(index, record, patch)

    if (Math.abs(patch.layout_label_ratio - DEFAULT_LABEL_RATIO) < 0.0001) {
      removeRecordValue(lines, record, "layout_label_ratio")
      continue
    }
    replaceOrInsertRecordValue(
      lines,
      record,
      "layout_label_ratio",
      formatRatio(patch.layout_label_ratio),
      "protocol"
    )
  }

  return lines.join("\n")
}

function assertSameEdge(index: number, record: YamlRecord, patch: EdgeLabelLayoutPatch): void {
  const from = unquoteYamlValue(record.values.from)
  const to = unquoteYamlValue(record.values.to)
  const relation = unquoteYamlValue(record.values.relation)
  const protocol = unquoteYamlValue(record.values.protocol)
  if (
    from !== patch.from ||
    to !== patch.to ||
    relation !== patch.relation ||
    protocol !== patch.protocol
  ) {
    throw new LayoutSaveError(
      `Cannot save edge label ${index}: payload does not match architecture-map.yml.`,
      "patch_failed"
    )
  }
}

function getYamlRecords(lines: string[], section: "nodes" | "edges"): YamlRecord[] {
  const records: YamlRecord[] = []
  let inSection = false
  let currentStart = -1

  for (let lineIndex = 0; lineIndex <= lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ""
    const isTopLevel = lineIndex < lines.length && /^\S/.test(line)

    if (lineIndex === lines.length || (isTopLevel && inSection && !line.startsWith(`${section}:`))) {
      if (currentStart >= 0) {
        records.push(parseYamlRecord(lines, currentStart, lineIndex))
        currentStart = -1
      }
      inSection = false
    }

    if (line.startsWith(`${section}:`)) {
      inSection = true
      currentStart = -1
      continue
    }

    if (!inSection) continue

    if (/^ {2}- /.test(line)) {
      if (currentStart >= 0) {
        records.push(parseYamlRecord(lines, currentStart, lineIndex))
      }
      currentStart = lineIndex
    }
  }

  return records
}

function parseYamlRecord(lines: string[], start: number, end: number): YamlRecord {
  const values: Record<string, string> = {}
  const keyLines = new Map<string, number>()

  for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
    const entry = parseRecordLine(lines[lineIndex])
    if (!entry) continue
    const [key, value] = entry
    values[key] = value
    keyLines.set(key, lineIndex)
  }

  return { start, end, values, keyLines }
}

function parseRecordLine(line: string): [string, string] | null {
  const inlineRecord = line.match(/^ {2}- ([^:]+):\s*(.*)$/)
  if (inlineRecord) {
    return [inlineRecord[1], inlineRecord[2]]
  }
  const property = line.match(/^ {4}([^:]+):\s*(.*)$/)
  if (property) {
    return [property[1], property[2]]
  }
  return null
}

function replaceRecordValue(lines: string[], record: YamlRecord, key: string, value: string): void {
  const lineIndex = record.keyLines.get(key)
  if (lineIndex === undefined) {
    throw new LayoutSaveError(
      `Cannot save layout: missing ${key} for record at line ${record.start + 1}.`,
      "patch_failed"
    )
  }
  lines[lineIndex] = `    ${key}: ${value}`
}

function replaceOrInsertRecordValue(
  lines: string[],
  record: YamlRecord,
  key: string,
  value: string,
  insertAfterKey: string
): void {
  const lineIndex = record.keyLines.get(key)
  if (lineIndex !== undefined) {
    lines[lineIndex] = `    ${key}: ${value}`
    return
  }
  const insertAfterLineIndex = record.keyLines.get(insertAfterKey) ?? record.start
  lines.splice(insertAfterLineIndex + 1, 0, `    ${key}: ${value}`)
}

function removeRecordValue(lines: string[], record: YamlRecord, key: string): void {
  const lineIndex = record.keyLines.get(key)
  if (lineIndex !== undefined) {
    lines.splice(lineIndex, 1)
  }
}

function unquoteYamlValue(value = ""): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string
  }
  return trimmed
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString()
}

function formatRatio(value: number): string {
  return Number(value.toFixed(4)).toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// --------------------------------------------------------------------------
// Filesystem save + regeneration (the side-effecting layer).
// --------------------------------------------------------------------------

/**
 * Operator kill-switch mirroring the old viewer's server-side write gate. Writes
 * are enabled by default (the UI edit-mode toggle is the everyday gate); setting
 * `VIVICY_MAP_LAYOUT_WRITE` to a falsey value hard-locks this endpoint so the map
 * cannot be mutated even by a direct request.
 */
export function isLayoutWriteEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const flag = env.VIVICY_MAP_LAYOUT_WRITE
  if (flag === undefined) return true
  const normalized = flag.trim().toLowerCase()
  return !(normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off")
}

/**
 * Resolve the absolute path of the target project's source map, guarding against
 * traversal even though the relative path is a fixed in-repo constant.
 */
export function resolveMapPath(targetRoot: string): string {
  const abs = path.resolve(targetRoot, MAP_RELATIVE_PATH)
  const rel = path.relative(targetRoot, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new LayoutSaveError(`map path escapes target root: ${MAP_RELATIVE_PATH}`, "patch_failed")
  }
  return abs
}

/** Regenerate the served viewer data by invoking the factory generator. */
async function regenerateViewerData(targetRoot: string): Promise<void> {
  const factoryRoot = getFactoryRoot()
  const script = path.join(factoryRoot, "generate-viewer-data.ts")
  if (!existsSync(script)) {
    throw new LayoutSaveError(`viewer-data generator not found: ${script}`, "regen_failed")
  }
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [script],
      { cwd: factoryRoot, env: { ...process.env, VIVICY_TARGET_ROOT: targetRoot } },
      (error, _stdout, stderr) => {
        if (error) {
          reject(
            new LayoutSaveError(
              `viewer-data regeneration failed: ${stderr.trim() || error.message}`,
              "regen_failed"
            )
          )
        } else {
          resolve()
        }
      }
    )
  })
}

export interface LayoutSaveOptions {
  payload: LayoutSavePayload
  /** Defaults to the resolved target project root. */
  targetRoot?: string
  /** Injection seam for the regeneration step (real impl invokes the generator). */
  regenerate?: (targetRoot: string) => Promise<void>
}

/**
 * Patch the target map's layout and regenerate the viewer data. Writes the
 * patched YAML, then regenerates; if regeneration fails the source file is rolled
 * back to its pre-save bytes so a bad save never leaves the map half-written.
 */
export async function applyLayoutSave(
  options: LayoutSaveOptions
): Promise<{ ok: true; mapPath: string }> {
  if (!isLayoutWriteEnabled()) {
    throw new LayoutSaveError(
      "Layout saving is disabled (VIVICY_MAP_LAYOUT_WRITE is off); the architecture map is read-only.",
      "read_only"
    )
  }
  const targetRoot = options.targetRoot ?? getTargetRoot()
  if (!targetRoot || !existsSync(targetRoot)) {
    throw new LayoutSaveError(`target project not found: ${targetRoot}`, "no_target")
  }
  const mapPath = resolveMapPath(targetRoot)
  if (!existsSync(mapPath)) {
    throw new LayoutSaveError(`architecture map not found: ${mapPath}`, "no_map")
  }

  const original = readFileSync(mapPath, "utf8")
  const next = patchArchitectureMapLayout(original, options.payload)
  writeFileSync(mapPath, next)

  const regenerate = options.regenerate ?? regenerateViewerData
  try {
    await regenerate(targetRoot)
  } catch (error) {
    // Roll the source back so a failed regeneration never leaves a divergent map.
    writeFileSync(mapPath, original)
    throw error instanceof LayoutSaveError
      ? error
      : new LayoutSaveError(
          error instanceof Error ? error.message : "viewer-data regeneration failed",
          "regen_failed"
        )
  }

  return { ok: true, mapPath }
}
