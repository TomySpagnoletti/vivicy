import { readFile } from "node:fs/promises"

import { applyLiveOverlay, normalizeMapData } from "@/lib/map-data"
import {
  getArchitectureDataPath,
  getProgressLedgerPath,
  getTargetRoot,
  isTargetResolved,
} from "@/lib/target"
import type { MapEmptyState } from "@/lib/types"

// Filesystem reads require the Node runtime, not Edge.
export const runtime = "nodejs"
// The map can change on disk between requests; never cache the response.
export const dynamic = "force-dynamic"

function emptyState(reason: MapEmptyState["reason"]): Response {
  const body: MapEmptyState = {
    empty: true,
    reason,
    targetRoot: getTargetRoot(),
  }
  return Response.json(body)
}

export async function GET() {
  if (!isTargetResolved()) {
    return emptyState("no_target")
  }

  const filePath = getArchitectureDataPath()
  if (filePath === null) {
    return emptyState("no_target")
  }

  let contents: string
  try {
    contents = await readFile(filePath, "utf8")
  } catch {
    return emptyState("no_map")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return Response.json(
      {
        error: "architecture map is not valid JSON",
        code: "map_not_json",
        detail: `Failed to parse ${filePath}.`,
      },
      { status: 422 }
    )
  }

  const data = normalizeMapData(parsed)
  if (!data) {
    return Response.json(
      {
        error: "architecture map has an unexpected shape",
        code: "map_bad_shape",
        detail: `The JSON at ${filePath} is missing a "name" or a "nodes" array.`,
      },
      { status: 422 }
    )
  }

  if (data.nodes.length === 0) {
    return emptyState("empty_map")
  }

  // The map JSON is generated once at extraction and never regenerated; the ledger is the live source of truth, overlaid here so a read always shows current progress. A missing/unreadable ledger leaves the static graph as-is (everything not_started).
  const ledger = await readLedger()
  return Response.json(applyLiveOverlay(data, ledger))
}

async function readLedger(): Promise<unknown> {
  const ledgerPath = getProgressLedgerPath()
  if (ledgerPath === null) return undefined
  try {
    return JSON.parse(await readFile(ledgerPath, "utf8")) as unknown
  } catch {
    return undefined
  }
}
