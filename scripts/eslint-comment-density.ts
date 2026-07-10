import type { Rule } from "eslint"
import type { Comment } from "estree"

// Calibrated to the invariant-only baseline (worst legitimate file ≈4%, small files carry 1-2 one-liners): narration-level commenting must fail the gate, sanctioned invariants must not.
export const FREE_COMMENT_LINES = 5
export const MAX_COMMENT_RATIO = 0.04

function isDirective(comment: Comment): boolean {
  if ((comment.type as string) === "Shebang") return true
  const value = comment.value.trim()
  if (comment.loc?.start.line === 1 && value.startsWith("!")) return true
  return (
    value.startsWith("eslint-") ||
    value.startsWith("@ts-") ||
    value.startsWith("/ <reference") ||
    value.startsWith("<reference")
  )
}

export const commentDensityRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Cap per-file comment density: zero comments by default, one-line non-derivable structural invariants only (AGENTS.md)",
    },
    schema: [],
    messages: {
      over: "{{count}} comment lines exceed this file's cap of {{cap}} ({{total}} lines). Vivicy is zero-comment by default: delete narration and keep only one-line structural invariants that are not derivable from the code — see AGENTS.md.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const source = context.sourceCode
        const commentLines = new Set<number>()
        for (const comment of source.getAllComments()) {
          if (isDirective(comment) || !comment.loc) continue
          for (let line = comment.loc.start.line; line <= comment.loc.end.line; line++) commentLines.add(line)
        }
        const total = source.lines.length
        const cap = Math.max(FREE_COMMENT_LINES, Math.ceil(total * MAX_COMMENT_RATIO))
        if (commentLines.size > cap) {
          context.report({
            node,
            loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
            messageId: "over",
            data: { count: String(commentLines.size), cap: String(cap), total: String(total) },
          })
        }
      },
    }
  },
}

export const vivicyCommentDensityPlugin = {
  rules: { "comment-density": commentDensityRule },
}
