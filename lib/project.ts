/**
 * Server-only store for Vivicy's "current target project" — the absolute path of
 * the repository the user chose to develop from the UI (R10).
 *
 * Vivicy is a LOCAL single-user tool: the Next server has filesystem access, so
 * the chosen project is persisted as JSON in the gitignored runtime dir
 * (`.vivicy-runtime/current-project.json`), the same dir the control plane and
 * settings store use. The resolution this enables lives in {@link file://./target}
 * and {@link file://./control}: a persisted current-project takes precedence over
 * the `VIVICY_TARGET_ROOT` env var, which stays the fallback (and the override the
 * E2E servers use).
 *
 * `node:fs` lives here so it never reaches the client bundle; the client-safe
 * types are in {@link file://./project-types}.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
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
  const root = candidate.trim()
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
  // A `docs/` directory is where the canonical spec lives, so flag it: the map
  // route surfaces a different onboarding state for a project that has no spec.
  const docs = path.join(root, "docs")
  let hasDocs = false
  try {
    hasDocs = statSync(docs).isDirectory()
  } catch {
    hasDocs = false
  }
  return { root, name: path.basename(root), hasDocs }
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
