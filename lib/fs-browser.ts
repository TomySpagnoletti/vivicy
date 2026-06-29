/**
 * Server-only directory browser backing `GET /api/fs/list` (R10). Browses the
 * operator's own filesystem (Vivicy is a local single-user tool) and enforces the
 * path-safety contract documented on {@link resolveBrowsePath}. `node:fs` lives
 * here so it never reaches the client bundle; client-safe types are in
 * {@link file://./project-types}.
 */

import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import type { DirListing } from "@/lib/project-types"

/** Typed reasons the browser rejects a path (so the route never invents prose). */
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

/**
 * Allowed new-folder names: 1–255 chars of letters, digits, space, dot,
 * underscore, or hyphen. This rejects path separators, traversal (`..` can't
 * form because `/` and a bare `.`-only name are excluded by requiring a leading
 * non-dot), absolute paths, and shell-significant characters by construction —
 * the name is a single path segment, never a path.
 */
const FOLDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,254}$/

/**
 * A sensible default browse root: the user's home directory. Honest and
 * machine-independent — derived from `os.homedir()`, never a hardcoded path.
 * (A `/Users/<me>/X_projects` style shortcut is offered in the UI as a quick
 * link, not baked into the server.)
 */
export function getDefaultBrowseRoot(): string {
  return homedir()
}

/**
 * Resolve a requested browse path to a safe, canonical, existing directory.
 *
 * Path-safety contract:
 *   - empty/whitespace -> the default browse root (home).
 *   - must be absolute (a relative path could escape into the server's cwd).
 *   - normalized to collapse `.`/`..` segments, then `realpath`-resolved so
 *     symlinks can't smuggle the listing somewhere the canonical path wouldn't
 *     reach; the resolved target must exist and be a directory.
 *
 * Returns the canonical absolute directory path. Throws {@link FsBrowseError}
 * otherwise. This is the single chokepoint every browse request passes through.
 */
export function resolveBrowsePath(requested: string | null | undefined): string {
  const raw = (requested ?? "").trim()
  if (raw.length === 0) return realpathSync(getDefaultBrowseRoot())

  if (!path.isAbsolute(raw)) {
    throw new FsBrowseError(`browse path must be absolute: ${raw}`, "not_absolute")
  }
  // Collapse `..`/`.` so a traversal-encoded string resolves to its real target
  // before we touch the disk; an absolute path can't normalize above the root.
  const normalized = path.normalize(raw)
  if (!existsSync(normalized)) {
    throw new FsBrowseError(`path does not exist: ${normalized}`, "not_found")
  }
  // Resolve symlinks to the canonical location so the listing reflects the real
  // directory, never a link target dressed up under a different path.
  const real = realpathSync(normalized)
  if (!statSync(real).isDirectory()) {
    throw new FsBrowseError(`path is not a directory: ${real}`, "not_a_directory")
  }
  return real
}

/**
 * List the immediate subdirectories of `requested` (default: home). Files and
 * dotfiles are omitted — the picker only navigates folders, and hidden dirs are
 * noise for choosing a project. Unreadable children (permission errors) are
 * skipped rather than failing the whole listing. The `parent` is the canonical
 * parent directory, or null when already at the filesystem root.
 */
export function listDirectories(requested: string | null | undefined): DirListing {
  const dir = resolveBrowsePath(requested)

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((dirent) => !dirent.name.startsWith("."))
    .filter((dirent) => {
      // Trust the dirent kind when it is a real directory; for symlinks (and
      // unknown kinds), stat the resolved child and keep it only if it points at
      // a directory. Unreadable/broken entries are skipped, never fatal.
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
  // At the filesystem root, dirname(dir) === dir; surface null so the UI hides
  // the parent-up entry there.
  const parent = parentCandidate === dir ? null : parentCandidate

  return { path: dir, parent, entries }
}

/** Validate a single new-folder name segment, or throw {@link FsBrowseError}. */
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

/**
 * Create a new subdirectory `name` inside the canonical, existing directory
 * `parent`, both passing the same path-safety contract the browser enforces:
 *   - `parent` is resolved through {@link resolveBrowsePath}, so it must be an
 *     absolute, existing, canonical (symlink-resolved) directory under the
 *     browse root — never a traversal-encoded or non-canonical string.
 *   - `name` is a single validated path segment (see {@link validateFolderName}),
 *     so it can carry no separator, no traversal, and no absolute path; the
 *     created path is therefore always a direct child of the resolved parent.
 *
 * Returns the absolute path of the created directory. Rejecting an already-
 * existing target with a typed `exists` code keeps the "already exists" error
 * honest instead of silently succeeding. `recursive` is intentionally OFF so a
 * name that somehow resolved deeper can never create a chain.
 */
export function createDirectory(parent: string | null | undefined, name: unknown): string {
  const dir = resolveBrowsePath(parent)
  const safeName = validateFolderName(name)
  const target = path.join(dir, safeName)

  // Defense in depth: the joined target must remain a direct child of the
  // resolved parent (it always is for a validated single segment, but assert it).
  if (path.dirname(target) !== dir) {
    throw new FsBrowseError(`folder name does not resolve to a direct child: ${safeName}`, "unsafe")
  }
  if (existsSync(target)) {
    throw new FsBrowseError(`a file or folder named "${safeName}" already exists here`, "exists")
  }

  mkdirSync(target)
  return target
}
