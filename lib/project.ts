/**
 * Server-only store for Vivicy's "current target project" (R10), persisted as
 * JSON in the gitignored runtime dir. Resolution (a persisted project wins over
 * `VIVICY_TARGET_ROOT`) lives in {@link file://./target}. `node:fs` lives here so
 * it never reaches the client bundle; client-safe types are in
 * {@link file://./project-types}.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { CurrentProject } from "@/lib/project-types"
import { getRuntimeDir } from "@/lib/runtime-dir"

const PROJECT_FILE = "current-project.json"

/** Absolute path to the current-project JSON store. */
export function getCurrentProjectPath(): string {
  return path.join(getRuntimeDir(), PROJECT_FILE)
}

/**
 * The persisted absolute project root, or null when none is set (or the file is
 * absent/corrupt). Never throws — a missing/bad file is simply "no project yet",
 * so the env fallback in {@link file://./target} still applies.
 */
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

/** Why a candidate project path was rejected (typed so the route never invents prose). */
export class ProjectError extends Error {
  constructor(
    message: string,
    readonly code: "not_absolute" | "not_found" | "not_a_directory"
  ) {
    super(message)
    this.name = "ProjectError"
  }
}

/**
 * Validate that `candidate` is an absolute path to an existing directory and
 * return its describing record. Throws a {@link ProjectError} otherwise. Pure
 * validation — does not persist anything.
 */
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
  // Canonicalize (resolve symlinks) so ONE directory has ONE spelling everywhere
  // downstream. The W8 per-project runtime key hashes this string — two spellings
  // of the same root (macOS /tmp vs /private/tmp) would otherwise fork the
  // project's namespace (run lock, notifications, sessions) mid-flight.
  try {
    root = realpathSync(root)
  } catch {
    // The dir just stat'ed fine; on a realpath hiccup keep the validated spelling.
  }
  // A `.vivicy/canonical/` directory is where the canonical spec lives, so flag it:
  // the map route surfaces a different onboarding state for a project with no spec.
  const canonicalDir = path.join(root, ".vivicy", "canonical")
  let hasCanonicalSpec = false
  try {
    hasCanonicalSpec = statSync(canonicalDir).isDirectory()
  } catch {
    hasCanonicalSpec = false
  }
  return { root, name: path.basename(root), hasCanonicalSpec }
}

/**
 * Persist a validated project as the current target, creating the runtime dir on
 * demand. Returns the describing record actually written, so the caller echoes
 * the validated values (never the raw request). Throws {@link ProjectError} when
 * the candidate is not an absolute path to an existing directory.
 */
export function setCurrentProject(candidate: string): CurrentProject {
  const described = describeProject(candidate)
  mkdirSync(getRuntimeDir(), { recursive: true })
  writeFileSync(
    getCurrentProjectPath(),
    `${JSON.stringify({ root: described.root }, null, 2)}\n`
  )
  return described
}

/**
 * The current project as a describing record, or null when none is set or the
 * persisted path no longer resolves to a directory (e.g. the repo was moved or
 * deleted). A stale persisted path returns null rather than throwing so the UI
 * falls back to the empty/onboarding state cleanly.
 */
export function getCurrentProject(): CurrentProject | null {
  const root = readCurrentProjectRoot()
  if (!root) return null
  try {
    return describeProject(root)
  } catch {
    return null
  }
}
