/**
 * Server-only directory browser backing `GET /api/fs/list` (R10).
 *
 * Vivicy is a LOCAL single-user tool, so the picker browses the operator's own
 * filesystem. This module enforces the path-safety the picker needs: a requested
 * path must be absolute, must resolve (after normalization) to an existing
 * directory, and must not be a traversal-encoded or non-canonical string — we
 * reject anything whose normalized+real form differs from a clean absolute
 * directory. Only DIRECTORIES are listed (the picker chooses a project folder,
 * never a file), and only the immediate children, so a single request can never
 * walk or enumerate the whole disk.
 *
 * `node:fs` lives here so it never reaches the client bundle; the client-safe
 * types are in {@link file://./project-types}.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import type { DirListing } from "@/lib/project-types"

/** Typed reasons the browser rejects a path (so the route never invents prose). */
export class FsBrowseError extends Error {
  constructor(
    message: string,
    readonly code: "not_absolute" | "not_found" | "not_a_directory" | "unsafe"
  ) {
    super(message)
    this.name = "FsBrowseError"
  }
}

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
