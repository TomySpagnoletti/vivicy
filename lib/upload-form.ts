import type { RawEntry } from "@/lib/import-docs"

export const IMPORT_STATUS_BY_CODE: Record<string, number> = {
  no_files: 400,
  no_supported_files: 400,
  not_governed: 409,
  zip_slip: 400,
  zip_unreadable: 400,
}

export async function readUploadEntries(form: FormData): Promise<RawEntry[]> {
  const files = form.getAll("files")
  const paths = form.getAll("paths")
  const entries: RawEntry[] = []
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    if (!(file instanceof File)) continue
    const rel = typeof paths[i] === "string" ? (paths[i] as string) : ""
    entries.push({ rel, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
  }
  return entries
}
