import { describe, expect, it } from "vitest"

import {
  describeFinding,
  hasHighConfidence,
  highConfidenceFindings,
  redactSecret,
  scanDocument,
  scanText,
  shannonEntropy,
  type SecretConfidence,
} from "@/lib/secret-scan"

// Fixtures are assembled at runtime from fragments so no contiguous provider-key literal ever sits in this source file: the detector receives the joined string, while push-protection scanners find nothing to flag.
const frag = (...parts: string[]): string => parts.join("")

const AWS_KEY = frag("AKIA", "ZQ3RTVWX7YB2NM5P")
const ANTHROPIC_KEY = frag("sk-ant-", "api03-Qz7Rp2Kw9Vn4Bh6Tm1Yj3Lf5Gd8Sx0UaWc")
const OPENAI_KEY = frag("sk-", "Qz7Rp2Kw9Vn4Bh6Tm1Yj3Lf5T3BlbkFJWx8Ua2Rt")
const GITHUB_KEY = frag("ghp_", "Qz7Rp2Kw9Vn4Bh6Tm1Yj3Lf5Gd8Sx0UaRt42")
const SLACK_KEY = frag("xoxb-", "9823hKpQ7RtWvZ2mNbXc4Ls")
const GOOGLE_KEY = frag("AIza", "SyDqWvXbNmKpLrTgHjFzSaReCyUiOp8Q7wR")
const GCP_OAUTH_KEY = frag("GOCSPX-", "Qz7Rp2Kw9Vn4Bh6Tm1Yj3Lf5")
const STRIPE_KEY = frag("sk_", "live_51Qz7Rp2Kw9Vn4Bh6Tm1Yj3Lf5")
const PRIVATE_KEY_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----"
const GENERIC = "Zx8Kq2Lp9Wm4Nv6Tb1Yh3Rj5Fd7Gs0"

interface KeySpec {
  name: string
  detector: string
  raw: string
  wrap: (raw: string) => string
}

const KEY_SPECS: KeySpec[] = [
  { name: "anthropic", detector: "openai_anthropic_key", raw: ANTHROPIC_KEY, wrap: (r) => `const client = anthropic('${r}')` },
  { name: "openai_legacy", detector: "openai_anthropic_key", raw: OPENAI_KEY, wrap: (r) => `OPENAI_API_KEY=${r}` },
  { name: "aws", detector: "aws_access_key_id", raw: AWS_KEY, wrap: (r) => `aws_access_key_id = ${r}` },
  { name: "github", detector: "github_token", raw: GITHUB_KEY, wrap: (r) => `token: ${r}` },
  { name: "slack", detector: "slack_token", raw: SLACK_KEY, wrap: (r) => `SLACK_BOT_TOKEN=${r}` },
  { name: "google", detector: "google_api_key", raw: GOOGLE_KEY, wrap: (r) => `maps key ${r} here` },
  { name: "gcp_oauth", detector: "google_oauth_client_secret", raw: GCP_OAUTH_KEY, wrap: (r) => `client_secret: ${r}` },
  { name: "stripe", detector: "stripe_secret_key", raw: STRIPE_KEY, wrap: (r) => `STRIPE_SECRET=${r}` },
  { name: "private_key", detector: "private_key_block", raw: PRIVATE_KEY_MARKER, wrap: (r) => r },
]

const REAL_KEYS = KEY_SPECS.map((k) => ({ name: k.name, detector: k.detector, raw: k.raw, line: k.wrap(k.raw) }))

function only<T>(items: T[]): T {
  expect(items).toHaveLength(1)
  return items[0]
}

describe("scanText — provider key shapes (high confidence)", () => {
  for (const key of REAL_KEYS) {
    it(`flags a ${key.name} key as high via ${key.detector}`, () => {
      const finding = only(scanText(key.line))
      expect(finding.confidence).toBe<SecretConfidence>("high")
      expect(finding.detector).toBe(key.detector)
      expect(finding.length).toBe(key.raw.length)
    })
  }
})

describe("scanText — redaction invariant (mutation-honest)", () => {
  it("never re-emits the raw secret in any finding field or rendered string", () => {
    for (const key of REAL_KEYS) {
      const findings = scanDocument("secrets.md", key.line)
      expect(findings.length).toBeGreaterThan(0)
      for (const finding of findings) {
        const emitted = `${JSON.stringify(finding)} ${describeFinding(finding)} ${finding.redacted}`
        expect(emitted, `${key.name} leaked its secret`).not.toContain(key.raw)
        expect(finding.redacted.length).toBeLessThanOrEqual(6)
        expect(key.raw.startsWith(finding.redacted.replace("…", ""))).toBe(true)
      }
    }
  })

  it("redactSecret shows at most the first four characters and never the whole token", () => {
    expect(redactSecret(frag("sk-ant-", "api03-SECRETPART1234567890"))).toBe("sk-a…")
    for (const key of REAL_KEYS) {
      const redacted = redactSecret(key.raw)
      expect(redacted.endsWith("…")).toBe(true)
      expect(redacted.length).toBeLessThan(key.raw.length)
      expect(redacted).not.toBe(key.raw)
    }
  })
})

describe("scanText — fake / example keys never flag", () => {
  const examples = [
    "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
    "OPENAI_API_KEY=sk-your-api-key-here-replace-this-value",
    "api_key: sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "token = ghp_example_token_placeholder_value_1234567",
    "stripe: sk_live_your_secret_key_goes_right_here_now",
    "key = AKIADEADBEEF0000DEAD",
  ]
  for (const line of examples) {
    it(`does not flag: ${line.slice(0, 32)}…`, () => {
      expect(scanText(line)).toEqual([])
    })
  }
})

describe("scanText — a real credential in placeholder-adjacent prose is still flagged (judge the token, not the line)", () => {
  const evasions: Array<{ name: string; prefix: string; raw: string; detector: string }> = [
    { name: "aws after 'For example,'", prefix: "For example, the production deploy key is ", raw: AWS_KEY, detector: "aws_access_key_id" },
    { name: "anthropic after 'sample call:'", prefix: "Here is a sample call: ", raw: ANTHROPIC_KEY, detector: "openai_anthropic_key" },
    { name: "github after 'not a fake:'", prefix: "This is not a fake: ", raw: GITHUB_KEY, detector: "github_token" },
    { name: "slack after 'replace the placeholder'", prefix: "replace the placeholder with ", raw: SLACK_KEY, detector: "slack_token" },
  ]
  for (const e of evasions) {
    it(`flags a real key even when the sentence says a placeholder word: ${e.name}`, () => {
      const findings = scanText(e.prefix + e.raw)
      const high = findings.filter((f) => f.confidence === "high")
      expect(high, `${e.name}: line-scope placeholder must not drop a real credential`).toHaveLength(1)
      expect(high[0].detector).toBe(e.detector)
      const emitted = findings.map((f) => `${JSON.stringify(f)} ${describeFinding(f)}`).join(" ")
      expect(emitted).not.toContain(e.raw)
    })
  }
})

describe("scanText — generic high-entropy secret assignment", () => {
  it("flags a high-entropy value assigned to a secret-named identifier as generic", () => {
    const finding = only(scanText(`DB_PASSWORD = ${GENERIC}`))
    expect(finding.confidence).toBe<SecretConfidence>("generic")
    expect(finding.detector).toBe("high_entropy_secret_assignment")
  })

  it("does not flag a low-entropy value even when assigned to a secret identifier", () => {
    expect(scanText("password = aaaaaaaaaaaaaaaaaaaaaaaa")).toEqual([])
    expect(scanText("token: correcthorsebatterystaple")).toEqual([])
  })

  it("does not flag a high-entropy value on a non-secret identifier", () => {
    expect(scanText(`build_id = ${GENERIC}`)).toEqual([])
  })

  it("does not flag a plain prose sentence mentioning a token", () => {
    expect(scanText("The authentication token is issued per session and stored in an httpOnly cookie.")).toEqual([])
  })

  it("does not flag a bare sha256 hash", () => {
    expect(scanText("baseline hash 36dcf31444c4298026d629b5cc0b350d670eaf05a321315b1d9f3a11aad4f35f")).toEqual([])
  })
})

describe("scanText — dedup, lines, and helpers", () => {
  it("reports a provider key assigned to a secret var exactly once (high, not also generic)", () => {
    const finding = only(scanText(`OPENAI_API_KEY=${OPENAI_KEY}`))
    expect(finding.confidence).toBe<SecretConfidence>("high")
  })

  it("reports the 1-based line number of each finding", () => {
    const text = `line one\nline two\naws_access_key_id = ${AWS_KEY}\nline four`
    expect(only(scanText(text)).line).toBe(3)
  })

  it("hasHighConfidence / highConfidenceFindings split by confidence class", () => {
    const findings = scanText(`aws_access_key_id = ${AWS_KEY}\nDB_PASSWORD = ${GENERIC}`)
    expect(findings).toHaveLength(2)
    expect(hasHighConfidence(findings)).toBe(true)
    expect(highConfidenceFindings(findings)).toHaveLength(1)
    expect(highConfidenceFindings(findings)[0].detector).toBe("aws_access_key_id")
  })

  it("scanDocument threads the file path onto every finding", () => {
    const findings = scanDocument("docs/brief.md", `aws_access_key_id = ${AWS_KEY}`)
    expect(findings[0].path).toBe("docs/brief.md")
  })
})

describe("shannonEntropy", () => {
  it("is zero for a single repeated char and high for a random token", () => {
    expect(shannonEntropy("")).toBe(0)
    expect(shannonEntropy("aaaaaaaa")).toBe(0)
    expect(shannonEntropy(GENERIC)).toBeGreaterThan(4)
  })
})
