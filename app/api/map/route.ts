import { readFile } from "node:fs/promises"

import { applyLiveOverlay, normalizeMapData } from "@/lib/map-data"
import {
  getArchitectureDataPath,
  getProgressLedgerPath,
  getTargetRoot,
  isTargetResolved,
} from "@/lib/target"
import type { MapEmptyState } from "@/lib/types"

// Reads from the local filesystem, so this route must run on Node, not Edge.
export const runtime = "nodejs"
// The map can change on disk; never cache the response.
export const dynamic = "force-dynamic"

/** Build the onboarding payload for a given reason; always HTTP 200. */
function emptyState(reason: MapEmptyState["reason"]): Response {
  const body: MapEmptyState = {
    empty: true,
    reason,
    targetRoot: getTargetRoot(),
  }
  return Response.json(body)
}

export async function GET() {
  // (a) No usable project resolved yet — the onboarding signal that the viewer
  // needs a target whose docs/ holds the canonical spec. A real folder picker
  // and start modes arrive in a later phase.
  if (!isTargetResolved()) {
    return emptyState("no_target")
  }

  const filePath = getArchitectureDataPath()

  // (b) The target exists but no architecture map has been generated yet.
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
      { error: "architecture map is not valid JSON", detail: `Failed to parse ${filePath}.` },
      { status: 422 }
    )
  }

  const data = normalizeMapData(parsed)
  if (!data) {
    return Response.json(
      {
        error: "architecture map has an unexpected shape",
        detail: `The JSON at ${filePath} is missing a "name" or a "nodes" array.`,
      },
      { status: 422 }
    )
  }

  // (c) A valid map is present but carries no nodes — same onboarding family.
  if (data.nodes.length === 0) {
    return emptyState("empty_map")
  }

  // Overlay the LIVE progress ledger onto the STATIC graph at read time. The
  // architecture-map JSON is generated once at extraction and never regenerated
  // during development; the ledger is the single source of truth for live
  // progress. Deriving the overlay here means loading the target always shows
  // current progress with zero regeneration of the data file. Tolerant: a missing
  // or unreadable ledger leaves the static graph as-is (everything not_started).
  const ledger = await readLedger()
  return Response.json(applyLiveOverlay(data, ledger))
}

/**
 * Read and parse the live progress ledger, or `undefined` when it is absent or
 * unparseable. The overlay derivation treats `undefined` as "no live progress",
 * so a target mid-extraction (no ledger yet) renders the static graph cleanly.
 */
async function readLedger(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(getProgressLedgerPath(), "utf8")) as unknown
  } catch {
    return undefined
  }
}
