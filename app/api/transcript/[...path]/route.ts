import { readFile } from "node:fs/promises"
import path from "node:path"

import { getTargetRoot } from "@/lib/target"

// Reads the gitignored transcript store from the local filesystem, so this
// route must run on Node, not Edge.
export const runtime = "nodejs"
// Transcripts can be written while a run is in progress; never cache.
export const dynamic = "force-dynamic"

/**
 * Serve a captured agent transcript from the target project's gitignored
 * transcript store. Faithful port of the original viewer's Vite middleware:
 * read-only, restricted to `.vivicy/development/transcripts/**`, and only `.jsonl`
 * files. Path traversal is rejected.
 *
 * The client requests `/api/transcript/.vivicy/development/transcripts/<id>/<file>.jsonl`
 * (the `transcript_refs` value, verbatim). We rebuild that relative path, verify
 * it is inside the allowed directory, and stream the file as NDJSON.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params
  const rel = decodeURIComponent((segments ?? []).join("/"))

  // Allow only the transcript store, only .jsonl, and no traversal.
  if (
    rel.includes("..") ||
    !rel.startsWith(".vivicy/development/transcripts/") ||
    !rel.endsWith(".jsonl")
  ) {
    return new Response("bad transcript path", { status: 400 })
  }

  const targetRoot = getTargetRoot()
  const absolute = path.resolve(targetRoot, rel)
  // Defense in depth: the resolved path must still live under the target root's
  // transcript directory after normalization.
  const transcriptsDir = path.resolve(
    targetRoot,
    ".vivicy",
    "development",
    "transcripts"
  )
  if (
    absolute !== transcriptsDir &&
    !absolute.startsWith(transcriptsDir + path.sep)
  ) {
    return new Response("bad transcript path", { status: 400 })
  }

  let contents: string
  try {
    contents = await readFile(absolute, "utf8")
  } catch {
    return new Response("transcript not found", { status: 404 })
  }

  return new Response(contents, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  })
}
