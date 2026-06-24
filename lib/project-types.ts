/**
 * Client-safe types for the project-selection surface (R10). No filesystem
 * access, so client components (the Open-project dialog, the sidebar affordance)
 * import these without dragging `node:fs` into the bundle. The server-only store
 * is in {@link file://./project} and the directory browser in
 * {@link file://./fs-browser}.
 */

/** A describing record for a chosen (or candidate) project root. */
export interface CurrentProject {
  /** Absolute path to the project root. */
  root: string
  /** Display name (the basename of the root). */
  name: string
  /** Whether the root holds a `docs/` directory (where the canonical spec lives). */
  hasDocs: boolean
}

/** One directory entry in the server-side browser listing. */
export interface DirEntry {
  /** Display name of the subdirectory. */
  name: string
  /** Absolute path to the subdirectory. */
  path: string
}

/** The payload `GET /api/fs/list` returns for a browsed directory. */
export interface DirListing {
  /** Absolute path of the directory being listed. */
  path: string
  /** Absolute path of the parent directory, or null at the filesystem root. */
  parent: string | null
  /** Immediate subdirectories, sorted by name (case-insensitive). */
  entries: DirEntry[]
}
