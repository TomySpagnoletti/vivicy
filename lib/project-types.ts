// Client-safe: never add a filesystem import here.

export interface BoundProject {
  root: string
  name: string
  governed: boolean
}

export type ProjectBinding = { kind: "unbound" } | { kind: "missing"; root: string } | { kind: "bound"; project: BoundProject }

export interface RegisteredProject {
  root: string
  name: string
  port: number
  url: string
  running: boolean
  missing: boolean
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
