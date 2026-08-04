import { realpathSync, statSync } from "node:fs"
import path from "node:path"

import type { BoundProject, ProjectBinding } from "@/lib/project-types"
import { getTargetRoot } from "@/lib/target"

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly code: "not_absolute" | "not_found" | "not_a_directory"
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

export function describeProject(candidate: string): BoundProject {
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
  // Never drop this realpath: the registry keys a project by its root, and two spellings of one folder would fork it into two servers.
  try {
    root = realpathSync(root)
  } catch {}
  return { root, name: path.basename(root), governed: isGovernedRoot(root) }
}

// What this server IS: unbound is the launcher, missing is a bound root that vanished under it.
export function readProjectBinding(): ProjectBinding {
  const root = getTargetRoot()
  if (root === null) return { kind: "unbound" }
  try {
    return { kind: "bound", project: describeProject(root) }
  } catch {
    return { kind: "missing", root }
  }
}
