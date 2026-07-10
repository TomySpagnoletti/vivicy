import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import type { DirListing } from "@/lib/project-types"

export class FsBrowseError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_absolute"
      | "not_found"
      | "not_a_directory"
      | "unsafe"
      | "invalid_name"
      | "exists"
  ) {
    super(message)
    this.name = "FsBrowseError"
  }
}

const FOLDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,254}$/

export function getDefaultBrowseRoot(): string {
  return homedir()
}

// Chokepoint: every filesystem browse/create request in the app resolves its path through this function (2 callers: app/api/fs/list, app/api/fs/mkdir).
export function resolveBrowsePath(requested: string | null | undefined): string {
  const raw = (requested ?? "").trim()
  if (raw.length === 0) return realpathSync(getDefaultBrowseRoot())

  if (!path.isAbsolute(raw)) {
    throw new FsBrowseError(`browse path must be absolute: ${raw}`, "not_absolute")
  }
  const normalized = path.normalize(raw)
  if (!existsSync(normalized)) {
    throw new FsBrowseError(`path does not exist: ${normalized}`, "not_found")
  }
  const real = realpathSync(normalized)
  if (!statSync(real).isDirectory()) {
    throw new FsBrowseError(`path is not a directory: ${real}`, "not_a_directory")
  }
  return real
}

export function listDirectories(requested: string | null | undefined): DirListing {
  const dir = resolveBrowsePath(requested)

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((dirent) => !dirent.name.startsWith("."))
    .filter((dirent) => {
      // A symlink's dirent kind doesn't reflect its target; stat the resolved child instead, and skip unreadable/broken entries rather than fail the listing.
      if (dirent.isDirectory()) return true
      if (!dirent.isSymbolicLink()) return false
      try {
        return statSync(path.join(dir, dirent.name)).isDirectory()
      } catch {
        return false
      }
    })
    .map((dirent) => ({ name: dirent.name, path: path.join(dir, dirent.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))

  const parentCandidate = path.dirname(dir)
  // path.dirname of the filesystem root returns the root itself; surface null so the UI hides the parent-up entry there.
  const parent = parentCandidate === dir ? null : parentCandidate

  return { path: dir, parent, entries }
}

export function validateFolderName(input: unknown): string {
  const name = typeof input === "string" ? input.trim() : ""
  if (!FOLDER_NAME_RE.test(name) || name === "." || name === "..") {
    throw new FsBrowseError(
      "folder name must be 1–255 chars: letters, digits, space, dot, underscore, or hyphen (starting alphanumeric), with no path separators",
      "invalid_name"
    )
  }
  return name
}

export function createDirectory(parent: string | null | undefined, name: unknown): string {
  const dir = resolveBrowsePath(parent)
  const safeName = validateFolderName(name)
  const target = path.join(dir, safeName)

  // Defense in depth against a hypothetical validation bug: the joined target must still be a direct child of the resolved parent.
  if (path.dirname(target) !== dir) {
    throw new FsBrowseError(`folder name does not resolve to a direct child: ${safeName}`, "unsafe")
  }
  if (existsSync(target)) {
    throw new FsBrowseError(`a file or folder named "${safeName}" already exists here`, "exists")
  }

  // recursive:false intentionally — a name that somehow resolved deeper must fail loudly, never silently create a chain.
  mkdirSync(target)
  return target
}
