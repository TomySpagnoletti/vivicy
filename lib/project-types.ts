// Client-safe: no filesystem imports here — client components pull this in directly without dragging in node:fs.

export interface CurrentProject {
  root: string
  name: string
  hasCanonicalSpec: boolean
}

export interface DirEntry {
  name: string
  path: string
}

export interface DirListing {
  path: string
  parent: string | null
  entries: DirEntry[]
}
