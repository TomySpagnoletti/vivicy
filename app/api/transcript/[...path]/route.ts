import { readFile } from "node:fs/promises"
import path from "node:path"

import { getTargetRoot } from "@/lib/target"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params
  const rel = decodeURIComponent((segments ?? []).join("/"))

  if (
    rel.includes("..") ||
    !rel.startsWith(".vivicy/development/transcripts/") ||
    !rel.endsWith(".jsonl")
  ) {
    return new Response("bad transcript path", { status: 400 })
  }

  const targetRoot = getTargetRoot()
  if (targetRoot === null) {
    return new Response("transcript not found", { status: 404 })
  }
  const absolute = path.resolve(targetRoot, rel)
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
