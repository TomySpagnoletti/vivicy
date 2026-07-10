import { Linter } from "eslint"
import { describe, expect, it } from "vitest"

import { FREE_COMMENT_LINES, MAX_COMMENT_RATIO, vivicyCommentDensityPlugin } from "./eslint-comment-density"

const linter = new Linter()

function lint(code: string) {
  return linter.verify(code, {
    plugins: { vivicy: vivicyCommentDensityPlugin },
    rules: { "vivicy/comment-density": "error" },
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    linterOptions: { reportUnusedDisableDirectives: false },
  })
}

const codeLines = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i}`).join("\n")

describe("vivicy/comment-density", () => {
  it("passes a comment-free file", () => {
    expect(lint(codeLines(50))).toEqual([])
  })

  it("passes one-line invariants within the free allowance", () => {
    const code = `// invariant: must stay byte-compatible with the CLI lock file\n${codeLines(10)}`
    expect(lint(code)).toEqual([])
  })

  it("fails narration-level commenting in a small file", () => {
    const narration = Array.from({ length: FREE_COMMENT_LINES + 1 }, (_, i) => `// step ${i}: narrate the next line`).join("\n")
    const messages = lint(`${narration}\n${codeLines(20)}`)
    expect(messages).toHaveLength(1)
    expect(messages[0].message).toContain("zero-comment by default")
  })

  it("counts every line of a block comment", () => {
    const block = `/*\n${Array.from({ length: FREE_COMMENT_LINES + 2 }, () => " * essay").join("\n")}\n*/`
    expect(lint(`${block}\n${codeLines(20)}`)).toHaveLength(1)
  })

  it("scales the cap with file size for large files", () => {
    const total = 500
    const allowed = Math.ceil(total * MAX_COMMENT_RATIO)
    const invariants = Array.from({ length: allowed }, (_, i) => `// invariant ${i}`).join("\n")
    expect(lint(`${invariants}\n${codeLines(total - allowed)}`)).toEqual([])
    const over = Array.from({ length: allowed + 5 }, (_, i) => `// narration ${i}`).join("\n")
    expect(lint(`${over}\n${codeLines(total - allowed)}`)).toHaveLength(1)
  })

  it("exempts tool directives and shebangs from the count", () => {
    const directives = [
      "#!/usr/bin/env node",
      "// eslint-disable-next-line no-console",
      "// @ts-expect-error upstream types lag the runtime",
      "/* eslint-disable no-alert */",
      "/// <reference types=\"node\" />",
      "// @ts-nocheck",
    ].join("\n")
    expect(lint(`${directives}\n${codeLines(10)}`)).toEqual([])
  })
})
