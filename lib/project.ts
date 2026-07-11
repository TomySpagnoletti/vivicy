import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { CurrentProject } from "@/lib/project-types"
import { getRuntimeDir } from "@/lib/runtime-dir"

const PROJECT_FILE = "current-project.json"

export function getCurrentProjectPath(): string {
  return path.join(getRuntimeDir(), PROJECT_FILE)
}

export function readCurrentProjectRoot(): string | null {
  const file = getCurrentProjectPath()
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { root?: unknown }
    const root = typeof parsed.root === "string" ? parsed.root.trim() : ""
    return root.length > 0 ? root : null
  } catch {
    return null
  }
}

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly code: "not_absolute" | "not_found" | "not_a_directory" | "not_governed"
  ) {
    super(message)
    this.name = "ProjectError"
  }
}

export function isGovernedRoot(root: string): boolean {
  try {
    return statSync(path.join(root, ".vivicy")).isDirectory()
  } catch {
    return false
  }
}

export function describeProject(candidate: string): CurrentProject {
  let root = candidate.trim()
  if (!path.isAbsolute(root)) {
    throw new ProjectError(`project path must be absolute: ${candidate}`, "not_absolute")
  }
  let stat
  try {
    stat = statSync(root)
  } catch {
    throw new ProjectError(`path does not exist: ${root}`, "not_found")
  }
  if (!stat.isDirectory()) {
    throw new ProjectError(`path is not a directory: ${root}`, "not_a_directory")
  }
  // Resolve symlinks: the runtime key hashes this string, so an unresolved alias (e.g. macOS /tmp vs /private/tmp) would fork the project's runtime namespace.
  try {
    root = realpathSync(root)
  } catch {
  }
  const canonicalDir = path.join(root, ".vivicy", "canonical")
  let hasCanonicalSpec = false
  try {
    hasCanonicalSpec = statSync(canonicalDir).isDirectory()
  } catch {
    hasCanonicalSpec = false
  }
  return { root, name: path.basename(root), hasCanonicalSpec }
}

export function setCurrentProject(
  candidate: string,
  opts: { requireGoverned?: boolean } = {}
): CurrentProject {
  const described = describeProject(candidate)
  if (opts.requireGoverned && !isGovernedRoot(described.root)) {
    throw new ProjectError(
      `this folder is not governed by Vivicy: no .vivicy directory in ${described.root}`,
      "not_governed"
    )
  }
  mkdirSync(getRuntimeDir(), { recursive: true })
  writeFileSync(
    getCurrentProjectPath(),
    `${JSON.stringify({ root: described.root }, null, 2)}\n`
  )
  return described
}

export function getCurrentProject(): CurrentProject | null {
  const root = readCurrentProjectRoot()
  if (!root) return null
  try {
    return describeProject(root)
  } catch {
    return null
  }
}
