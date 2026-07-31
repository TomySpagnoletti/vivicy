import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { resolve } from "node:path"

import { PROJECT_CONFIG_FILENAME, readProjectConfigObject, updateProjectConfig } from "./project-config.ts"
import { parseSkillId, type SkillRef } from "./skill-id.ts"

const PROJECT_SKILLS_FIELD = "skills"

export const PROJECT_SKILLS_SOURCE = `${PROJECT_CONFIG_FILENAME}#${PROJECT_SKILLS_FIELD}`

const SHA256_RE = /^[0-9a-f]{64}$/

export interface SkillBundlePin {
  bundle_hash: string
  files: Record<string, string>
}

export interface SkillDeclaration {
  id: string
  pin: SkillBundlePin | null
}

export interface PinnedBundle {
  ref: SkillRef
  pin: SkillBundlePin
}

export interface BundleDrift {
  missing: boolean
  changed: string[]
}

function fileMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

function collectBundleFiles(dir: string, prefix: string, into: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name)
    const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) into[rel] = `symlink:${readlinkSync(abs)}`
    else if (entry.isDirectory()) collectBundleFiles(abs, rel, into)
    else if (entry.isFile()) into[rel] = `sha256:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`
    else into[rel] = `unsupported:${(lstatSync(abs).mode & 0o170000).toString(8)}`
  }
}

// Changing this framing re-pins every governed project; the NUL delimiters are what stop two entries being forged into one (a filename may contain a newline).
export function manifestHash(files: Record<string, string>): string {
  const hash = createHash("sha256")
  for (const rel of Object.keys(files).sort()) {
    hash.update(rel)
    hash.update("\0")
    hash.update(files[rel])
    hash.update("\0")
  }
  return hash.digest("hex")
}

export function hashBundle(bundleDir: string): SkillBundlePin | null {
  const walked = fileMap()
  try {
    collectBundleFiles(bundleDir, "", walked)
  } catch {
    return null
  }
  const files = fileMap()
  for (const rel of Object.keys(walked).sort()) files[rel] = walked[rel]
  return { bundle_hash: manifestHash(files), files }
}

export function bundleDrift(pin: SkillBundlePin, actual: SkillBundlePin | null, maxNamed = 4): BundleDrift | null {
  if (actual === null) return { missing: true, changed: [] }
  if (actual.bundle_hash === pin.bundle_hash) return null
  const changed = [...new Set([...Object.keys(pin.files), ...Object.keys(actual.files)])]
    .filter((rel) => pin.files[rel] !== actual.files[rel])
    .sort()
  return { missing: false, changed: changed.slice(0, maxNamed) }
}

function fileManifest(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fileMap()
  const files = fileMap()
  for (const [rel, hash] of Object.entries(value as Record<string, unknown>)) {
    if (typeof hash === "string" && hash.length > 0) files[rel] = hash
  }
  return files
}

function pinFromEntry(record: Record<string, unknown>): SkillBundlePin | null {
  const hash = record.bundle_hash
  if (typeof hash !== "string" || !SHA256_RE.test(hash)) return null
  return { bundle_hash: hash, files: fileManifest(record.files) }
}

function declarationsFromConfig(config: Record<string, unknown> | null): SkillDeclaration[] {
  const raw = config?.[PROJECT_SKILLS_FIELD]
  if (!Array.isArray(raw)) return []
  const declarations: SkillDeclaration[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === "string" ? record.id.trim() : ""
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    declarations.push({ id, pin: pinFromEntry(record) })
  }
  return declarations
}

export function readSkillDeclarations(repoRoot: string): SkillDeclaration[] {
  return declarationsFromConfig(readProjectConfigObject(repoRoot))
}

export function writeSkillDeclarations(repoRoot: string, declarations: readonly SkillDeclaration[]): boolean {
  return (
    updateProjectConfig(repoRoot, (config) => {
      config[PROJECT_SKILLS_FIELD] = declarations.map((declaration) =>
        declaration.pin === null
          ? { id: declaration.id }
          : { id: declaration.id, bundle_hash: declaration.pin.bundle_hash, files: declaration.pin.files }
      )
    }) === "written"
  )
}

export function pinnedBundles(declarations: readonly SkillDeclaration[]): PinnedBundle[] {
  const bundles: PinnedBundle[] = []
  for (const declaration of declarations) {
    const ref = parseSkillId(declaration.id)
    if (declaration.pin === null || ref === null) continue
    bundles.push({ ref, pin: declaration.pin })
  }
  return bundles
}

export function maintenanceNeeded(repoRoot: string): boolean {
  return pinnedBundles(readSkillDeclarations(repoRoot)).length > 0
}
