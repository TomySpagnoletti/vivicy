export type SecretConfidence = "high" | "generic"

export interface SecretFinding {
  line: number
  detector: string
  confidence: SecretConfidence
  redacted: string
  length: number
}

export interface SecretFileFinding extends SecretFinding {
  path: string
}

interface Detector {
  name: string
  re: RegExp
  minLen?: number
  validate?: (token: string) => boolean
}

function looksRandom(token: string): boolean {
  return /\d/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token))
}

const MAX_FINDINGS = 100
const REDACT_HEAD = 4
const GENERIC_MIN_LEN = 20
const GENERIC_MIN_ENTROPY = 3.2

const HIGH_DETECTORS: Detector[] = [
  { name: "aws_access_key_id", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g },
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: "github_fine_grained_pat", re: /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "google_oauth_client_secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g },
  { name: "stripe_secret_key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  {
    name: "openai_anthropic_key",
    re: /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9]{2,}(?:[-_][A-Za-z0-9]+)*/g,
    minLen: 24,
    validate: looksRandom,
  },
  { name: "private_key_block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
]

const SECRET_KEYWORD =
  "api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?key|auth[_-]?token|client[_-]?secret|private[_-]?key|credential"
const GENERIC_ASSIGNMENT = new RegExp(`(?:^|[^\\w.])[\\w.]*(?:${SECRET_KEYWORD})[\\w.]*\\s*[:=]\\s*["'\`]?([^\\s"'\`,;]{16,})`, "gi")

const PLACEHOLDER_RE =
  /example|placeholder|dummy|change[_-]?me|redacted|your[_-]?(?:api|key|token|secret|password)|<[^>]+>|x{4,}|\.\.\.|…|\*{3,}|\bfake\b|\bsample\b|test[_-]key|0000+|123456789|abcdefghij|deadbeef|notreal|replace[_-]?(?:me|with)/i

interface RawMatch {
  start: number
  end: number
  token: string
  detector: string
  confidence: SecretConfidence
}

export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

// Security invariant: an emitted excerpt is at most the token's first REDACT_HEAD characters, never the whole token.
export function redactSecret(raw: string): string {
  const head = raw.slice(0, Math.max(1, Math.min(REDACT_HEAD, raw.length - 1)))
  return `${head}…`
}

export function describeFinding(finding: SecretFinding): string {
  return `line ${finding.line}: ${finding.detector} (${finding.confidence}, ${finding.redacted} ×${finding.length})`
}

// Judge the TOKEN, never the surrounding line: prose saying "example" must never suppress a real credential.
function looksLikePlaceholder(token: string): boolean {
  if (PLACEHOLDER_RE.test(token)) return true
  if (/(.)\1{5,}/.test(token)) return true
  return false
}

function collectHigh(line: string): RawMatch[] {
  const matches: RawMatch[] = []
  for (const detector of HIGH_DETECTORS) {
    detector.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = detector.re.exec(line)) !== null) {
      const token = m[0]
      if (m.index === detector.re.lastIndex) detector.re.lastIndex += 1
      if (detector.minLen && token.length < detector.minLen) continue
      if (detector.validate && !detector.validate(token)) continue
      if (looksLikePlaceholder(token)) continue
      matches.push({ start: m.index, end: m.index + token.length, token, detector: detector.name, confidence: "high" })
    }
  }
  return matches
}

function collectGeneric(line: string, high: RawMatch[]): RawMatch[] {
  const matches: RawMatch[] = []
  GENERIC_ASSIGNMENT.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = GENERIC_ASSIGNMENT.exec(line)) !== null) {
    const value = m[1]
    const start = m.index + m[0].length - value.length
    const end = start + value.length
    if (m.index === GENERIC_ASSIGNMENT.lastIndex) GENERIC_ASSIGNMENT.lastIndex += 1
    if (value.length < GENERIC_MIN_LEN) continue
    if (looksLikePlaceholder(value)) continue
    if (!/\d/.test(value) && !(/[a-z]/.test(value) && /[A-Z]/.test(value))) continue
    if (shannonEntropy(value) < GENERIC_MIN_ENTROPY) continue
    if (high.some((h) => start < h.end && end > h.start)) continue
    matches.push({ start, end, token: value, detector: "high_entropy_secret_assignment", confidence: "generic" })
  }
  return matches
}

export function scanText(text: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length && findings.length < MAX_FINDINGS; i += 1) {
    const line = lines[i]
    const high = collectHigh(line)
    const raw = [...high, ...collectGeneric(line, high)].sort((a, b) => a.start - b.start)
    for (const match of raw) {
      if (findings.length >= MAX_FINDINGS) break
      findings.push({
        line: i + 1,
        detector: match.detector,
        confidence: match.confidence,
        redacted: redactSecret(match.token),
        length: match.token.length,
      })
    }
  }
  return findings
}

export function scanDocument(pathRel: string, text: string): SecretFileFinding[] {
  return scanText(text).map((finding) => ({ ...finding, path: pathRel }))
}

export function hasHighConfidence(findings: SecretFinding[]): boolean {
  return findings.some((finding) => finding.confidence === "high")
}

export function highConfidenceFindings<T extends SecretFinding>(findings: T[]): T[] {
  return findings.filter((finding) => finding.confidence === "high")
}
