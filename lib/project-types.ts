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

export interface DirCrumb {
  label: string
  path: string
}

export interface DirListing {
  path: string
  parent: string | null
  crumbs: DirCrumb[]
  entries: DirEntry[]
}
