// Server-only (node:fs): the dev-loop's presence check, the extraction gate, and the /api/map reader all resolve declared proofs through this one module — never fork it. Client components use the subset shapes in lib/types.ts, which the /api/map assignment keeps structurally in lock-step.

import { lstatSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"

export const PROOFS_DIR = ".vivicy/development/proofs"

export const GATES_DIR = ".vivicy/development/gates"

export const ISSUES_DIR = ".vivicy/development/issues"

export const PROOF_RECIPE_FILE = "recipe.txt"

export const PROOF_SECTION_HEADING = "Proofs"

export interface ProofClass {
  id: string
  obligation: string
  production: string
}

export const PROOF_CLASSES: readonly ProofClass[] = [
  {
    id: "ui_flow",
    obligation: "an obligation a person SEES — a screen, a rendered state, a flow through the interface",
    production:
      "boot the product with the command in `vivicy.json#runCommand`, drive the named states, and capture each at a desktop-class AND a mobile-class viewport",
  },
  {
    id: "http_transcript",
    obligation: "an obligation observable at an HTTP/RPC boundary — a request and the response it must produce",
    production:
      "call the really-running product with a real client (curl or equivalent) and save the full request + response transcript, secrets redacted",
  },
  {
    id: "run_log",
    obligation: "an obligation a process performs — a CLI command, a job, a migration, a scheduled task",
    production: "run the real command against the built product and save the console output that shows the observed behaviour",
  },
  {
    id: "gate_evidence",
    obligation: "a pure-logic obligation whose only honest witness is its own test run — a computation, a parse, a data rule",
    production:
      "nothing to produce: the gate's own evidence record under `.vivicy/development/gates/` IS the proof, so never add a ritual artifact beside it",
  },
]

export const PROOF_CLASS_IDS: readonly string[] = PROOF_CLASSES.map((entry) => entry.id)

export function proofClass(id: string): ProofClass | null {
  return PROOF_CLASSES.find((entry) => entry.id === id) ?? null
}

export interface DeclaredProof {
  id: string
  class: string
  evidences: string[]
}

export interface DeclaredProofs {
  proofs: DeclaredProof[]
  problems: string[]
}

export interface ProofStatus extends DeclaredProof {
  path: string
  produced: boolean
  recipe: boolean
  artifacts: string[]
}

export interface IssueProofs {
  issue_id: string
  proofs: ProofStatus[]
}

export interface ProofInspection {
  statuses: ProofStatus[]
  problems: string[]
}

interface ProofDirs {
  proofsDir?: string
  gatesDir?: string
}

// Both ids below are interpolated into a filesystem path, so the accepted set is closed on every axis: no separator, no dot segment, bounded length.
const PROOF_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const PROOF_SLUG_MAX = 64

const CANONICAL_REF_RE = /^\.vivicy\/canonical\/[^\s:]+\.md:\d+(?:-\d+)?$/

export function isProofSlug(value: string): boolean {
  return value.length <= PROOF_SLUG_MAX && PROOF_SLUG_RE.test(value) && !value.includes("..")
}

export function gateEvidenceRel(issueId: string, gatesDir: string = GATES_DIR): string {
  return `${gatesDir}/${issueId}-gate.json`
}

export function proofHomeRel(issueId: string, proofId: string, proofsDir: string = PROOFS_DIR): string {
  return `${proofsDir}/${issueId}/${proofId}`
}

export function proofArtifactHomeRel(proof: DeclaredProof, issueId: string, dirs: ProofDirs = {}): string {
  return proof.class === "gate_evidence"
    ? gateEvidenceRel(issueId, dirs.gatesDir ?? GATES_DIR)
    : proofHomeRel(issueId, proof.id, dirs.proofsDir ?? PROOFS_DIR)
}

interface ProofsSection {
  found: boolean
  block: string | null
  strayDeclaration: string | null
  unreachable: boolean
}

const FENCE_RE = /^ {0,3}```/

const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/

const DECLARATION_SHAPED_RE = /^\s*(?:-\s*id\s*:|class\s*:|evidences\s*:)/

// CommonMark ATX: up to three leading spaces, and an optional closing run of #s.
function isProofsHeading(line: string): boolean {
  const match = /^ {0,3}##[ \t]+(.*?)[ \t]*$/.exec(line)
  if (!match) return false
  return match[1].replace(/[ \t]*#+$/, "").trim() === PROOF_SECTION_HEADING
}

// Line-based and fence-aware: a heading quoted inside a CLOSED fence is an example, not a section, but a heading swallowed by an UNTERMINATED fence is a defect the reader must report rather than vanish. CRLF is normalized once, here, at the boundary.
function proofsSection(body: string): ProofsSection {
  const lines = body.replace(/\r\n?/g, "\n").split("\n")
  let start = -1
  let inFence = false
  let fencedCandidate = false
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (!isProofsHeading(lines[i])) continue
    if (!inFence) {
      start = i + 1
      break
    }
    fencedCandidate = true
  }
  if (start === -1) {
    // An unterminated fence above the section is what hid it; a closed one means the heading was only quoted.
    return { found: inFence && fencedCandidate, block: null, strayDeclaration: null, unreachable: inFence && fencedCandidate }
  }

  const collected: string[] = []
  let block: string | null = null
  let fenceOpen = false
  let stray: string | null = null
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    if (!fenceOpen && ATX_HEADING_RE.test(line)) break
    if (FENCE_RE.test(line)) {
      if (!fenceOpen) {
        if (block !== null && stray === null) stray = line.trim()
        fenceOpen = true
        continue
      }
      fenceOpen = false
      if (block === null) block = collected.join("\n")
      continue
    }
    if (fenceOpen) {
      if (block === null) collected.push(line)
      continue
    }
    // A half-read declaration is indistinguishable from an honest one, so declaration-shaped prose outside the block is reported, never dropped.
    if (stray === null && DECLARATION_SHAPED_RE.test(line)) stray = line.trim()
  }
  return { found: true, block, strayDeclaration: stray, unreachable: false }
}

interface PendingProof {
  id: string
  class: string | null
  evidences: string[]
}

export function parseDeclaredProofs(body: string | null | undefined): DeclaredProofs {
  const section = proofsSection(String(body ?? ""))
  if (!section.found) return { proofs: [], problems: [] }
  if (section.unreachable) {
    return {
      proofs: [],
      problems: [
        `the "## ${PROOF_SECTION_HEADING}" section sits inside an unterminated code fence opened earlier in the file, so nothing in it can be read — close that fence`,
      ],
    }
  }
  if (section.block === null || section.block.trim().length === 0) {
    return {
      proofs: [],
      problems: [
        `the "## ${PROOF_SECTION_HEADING}" section carries no closed, non-empty \`text\` block — a declaration the machine cannot read is not a declaration; omit the section entirely when nothing is owed`,
      ],
    }
  }
  const strayProblems = section.strayDeclaration
    ? [
        `the "## ${PROOF_SECTION_HEADING}" section carries declaration content outside its one \`text\` block ("${section.strayDeclaration}") — every proof goes inside that single block or it is invisible to the machine`,
      ]
    : []

  const proofs: DeclaredProof[] = []
  const problems: string[] = [...strayProblems]
  const seen = new Set<string>()
  let pending: PendingProof | null = null
  let inEvidences = false

  const flush = (): void => {
    if (!pending) return
    const { id, evidences } = pending
    const declaredClass = pending.class
    pending = null
    if (!isProofSlug(id)) {
      problems.push(
        `proof id "${id}" is not a safe slug (letters, digits, dot, underscore, hyphen; at most ${PROOF_SLUG_MAX} characters)`,
      )
      return
    }
    if (seen.has(id)) {
      problems.push(`duplicate proof id "${id}"`)
      return
    }
    seen.add(id)
    if (!declaredClass) {
      problems.push(`proof "${id}" declares no class (one of: ${PROOF_CLASS_IDS.join(", ")})`)
      return
    }
    if (!PROOF_CLASS_IDS.includes(declaredClass)) {
      problems.push(`proof "${id}" declares unknown class "${declaredClass}" (one of: ${PROOF_CLASS_IDS.join(", ")})`)
      return
    }
    if (evidences.length === 0) {
      problems.push(`proof "${id}" cites no canonical line it evidences`)
      return
    }
    const malformed = evidences.filter((ref) => !CANONICAL_REF_RE.test(ref) || ref.includes(".."))
    if (malformed.length > 0) {
      problems.push(`proof "${id}" cites "${malformed[0]}", not a .vivicy/canonical/<file>.md:<start>[-<end>] line ref`)
      return
    }
    proofs.push({ id, class: declaredClass, evidences })
  }

  for (const raw of section.block.split("\n")) {
    const line = raw.trim()
    if (line.length === 0) continue
    const entry = /^-\s*id:\s*(.+)$/.exec(line)
    if (entry) {
      flush()
      pending = { id: entry[1].trim(), class: null, evidences: [] }
      inEvidences = false
      continue
    }
    if (!pending) {
      problems.push(`proofs block line "${line}" appears before the first "- id: <slug>" entry`)
      continue
    }
    const classLine = /^class:\s*(.+)$/.exec(line)
    if (classLine) {
      pending.class = classLine[1].trim()
      inEvidences = false
      continue
    }
    if (/^evidences:\s*$/.test(line)) {
      inEvidences = true
      continue
    }
    const item = /^-\s*(.+)$/.exec(line)
    if (item && inEvidences) {
      pending.evidences.push(item[1].trim())
      continue
    }
    problems.push(`unparseable proofs line "${line}"`)
  }
  flush()
  return { proofs, problems }
}

const ARTIFACT_DEPTH = 2

// lstat, never stat: a symlink pointing at something else on disk is not an observation this run produced.
function nonEmptyRegularFile(abs: string): boolean {
  try {
    const stat = lstatSync(abs)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

function listArtifacts(homeAbs: string, depth = ARTIFACT_DEPTH, prefix = ""): string[] {
  let entries
  try {
    entries = readdirSync(homeAbs, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (depth > 1) found.push(...listArtifacts(path.join(homeAbs, entry.name), depth - 1, rel))
      continue
    }
    if (nonEmptyRegularFile(path.join(homeAbs, entry.name))) found.push(rel)
  }
  return found.sort()
}

function gateProofStatus(proof: DeclaredProof, rel: string, abs: string): ProofStatus {
  let record: { status?: unknown; command?: unknown } | null = null
  try {
    record = JSON.parse(readFileSync(abs, "utf8")) as { status?: unknown; command?: unknown }
  } catch {
    record = null
  }
  const passed = record?.status === "pass"
  const command = typeof record?.command === "string" && record.command.trim().length > 0
  return {
    id: proof.id,
    class: proof.class,
    evidences: proof.evidences,
    path: rel,
    produced: passed && command,
    recipe: command,
    artifacts: passed ? [path.basename(rel)] : [],
  }
}

export function proofStatus(
  proof: DeclaredProof,
  { targetRoot, issueId, dirs = {} }: { targetRoot: string; issueId: string; dirs?: ProofDirs }
): ProofStatus {
  const rel = proofArtifactHomeRel(proof, issueId, dirs)
  const abs = path.join(targetRoot, ...rel.split("/"))
  if (proof.class === "gate_evidence") return gateProofStatus(proof, rel, abs)
  const artifacts = listArtifacts(abs)
  const recipe = nonEmptyRegularFile(path.join(abs, PROOF_RECIPE_FILE))
  return {
    id: proof.id,
    class: proof.class,
    evidences: proof.evidences,
    path: rel,
    produced: recipe && artifacts.some((name) => name !== PROOF_RECIPE_FILE),
    recipe,
    artifacts,
  }
}

export function inspectDeclaredProofs({
  targetRoot,
  issueId,
  body,
  dirs = {},
}: {
  targetRoot: string
  issueId: string
  body: string | null | undefined
  dirs?: ProofDirs
}): ProofInspection {
  const declared = parseDeclaredProofs(body)
  return {
    statuses: declared.proofs.map((proof) => proofStatus(proof, { targetRoot, issueId, dirs })),
    problems: declared.problems,
  }
}

const ISSUE_DIRS = [ISSUES_DIR, `${ISSUES_DIR}/done`]

// An issue file sits in the open dir before its close and in done/ after it; every reader looks in both.
export function readIssueBodyFromDisk(targetRoot: string, issueId: string): string | null {
  if (!isProofSlug(issueId)) return null
  for (const rel of ISSUE_DIRS) {
    const abs = path.join(targetRoot, ...rel.split("/"), `${issueId}.md`)
    if (!nonEmptyRegularFile(abs)) continue
    try {
      return readFileSync(abs, "utf8")
    } catch {
      continue
    }
  }
  return null
}

function issueIdsOnDisk(targetRoot: string): string[] {
  const ids = new Set<string>()
  for (const rel of ISSUE_DIRS) {
    let names: string[]
    try {
      names = readdirSync(path.join(targetRoot, ...rel.split("/")))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue
      const id = name.slice(0, -3)
      if (isProofSlug(id)) ids.add(id)
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function readProofsByIssue(targetRoot: string): IssueProofs[] {
  const out: IssueProofs[] = []
  for (const issueId of issueIdsOnDisk(targetRoot)) {
    const body = readIssueBodyFromDisk(targetRoot, issueId)
    if (body === null) continue
    const { statuses } = inspectDeclaredProofs({ targetRoot, issueId, body })
    if (statuses.length > 0) out.push({ issue_id: issueId, proofs: statuses })
  }
  return out
}
