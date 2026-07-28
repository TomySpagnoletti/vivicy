import { readFencedBlock, stripFencedBlock } from "@/lib/fenced-block"

interface ViviQuestionOption {
  label: string
  recommended?: boolean
}

export interface ViviQuestion {
  id: string
  question: string
  options: ViviQuestionOption[]
}

// Server-minted id, LLM-authored questions: the stack turn carries the QUESTIONS only. An answer is never stored here — it is the ordinary user turn that carries it, so the thread stays the single store and a replayed answer can only ever produce the one line already in it.
export interface ViviQuestionStack {
  id: string
  questions: ViviQuestion[]
}

export interface ViviQuestionAnswerRef {
  stackId: string
  questionId: string
}

const QUESTIONS_TAG = "vivicy-questions"

export const MAX_QUESTIONS_PER_STACK = 6
const MIN_OPTIONS_PER_QUESTION = 2
const MAX_OPTIONS_PER_QUESTION = 3
const MAX_QUESTION_ID_LENGTH = 40
const MAX_QUESTION_LENGTH = 200
const MAX_OPTION_LABEL_LENGTH = 80
export const MAX_OTHER_ANSWER_LENGTH = 400

// The fence body is refused on SIZE before it is parsed or normalized: a leg reply is an untrusted-length boundary, and a stack of 6 cards at these bounds cannot exceed a fraction of this.
const MAX_FENCE_BODY_LENGTH = 16_384

// The serialized Q+A line's one separator: the server composes with it, the transcript carries it to the leg, the panel splits on it to render the two halves.
export const ANSWER_SEPARATOR = " → "

const QUESTION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export type QuestionsDirective = { questions: ViviQuestion[] } | { malformed: string } | null

// Stripped BEFORE the whitespace collapse, and the two orders are NOT equivalent: an invisible sitting between two whitespace runs would otherwise leave the double space `oneLine` exists to remove. Membership is one test — does the character render as NOTHING — because a label is LLM-authored, steerable by the documents the owner imports, and is BOTH rendered as an option and recorded verbatim into the transcript as the owner's answer: a character that makes those two disagree is a spoof, not a typo. Three classes deliberately FAIL that test and stay out: what renders as a BREAK (U+2028/U+2029), so the collapse turns it into a space instead of deleting a word boundary; the JOINERS U+200C/U+200D, which change what renders (they are what makes the family emoji one glyph, Persian mi-ravad one word, Devanagari k-ssa one cluster) and which this same function must pass through untouched since it also governs the owner's own typed answer; and `\p{Cf}` wholesale, which would eat the Arabic number signs (U+0600-0605).
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g

// One normalization at the boundary: a newline or a doubled space inside an LLM JSON string would otherwise reach a one-line serialization and a single-line card title.
export function oneLine(value: string): string {
  return value.replace(INVISIBLE, "").replace(/\s+/g, " ").trim()
}

export function parseQuestionsDirective(reply: string): QuestionsDirective {
  const block = readFencedBlock(reply, QUESTIONS_TAG)
  if (block === null) return null
  if (block.body.length > MAX_FENCE_BODY_LENGTH) {
    return {
      malformed: `the vivicy-questions block runs to ${block.body.length} characters — one stack takes at most ${MAX_FENCE_BODY_LENGTH}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(block.body)
  } catch {
    return { malformed: "the vivicy-questions block is not valid JSON" }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { malformed: "the vivicy-questions block must be a JSON array holding at least one question card" }
  }
  if (parsed.length > MAX_QUESTIONS_PER_STACK) {
    return {
      malformed: `the vivicy-questions block holds ${parsed.length} question cards — one stack takes at most ${MAX_QUESTIONS_PER_STACK}`,
    }
  }
  const questions: ViviQuestion[] = []
  const ids = new Set<string>()
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { malformed: "every question card must be a JSON object" }
    }
    const raw = entry as { id?: unknown; question?: unknown; options?: unknown; allowOther?: unknown }

    const id = typeof raw.id === "string" ? raw.id.trim() : ""
    if (id.length === 0 || id.length > MAX_QUESTION_ID_LENGTH || !QUESTION_ID_SHAPE.test(id)) {
      return {
        malformed: `every question card needs an "id" of 1 to ${MAX_QUESTION_ID_LENGTH} letters, digits, "-" or "_"`,
      }
    }
    if (ids.has(id)) {
      return { malformed: `two question cards share the id "${id}" — every id in a stack must be unique` }
    }
    ids.add(id)

    const question = typeof raw.question === "string" ? oneLine(raw.question) : ""
    if (question.length === 0 || question.length > MAX_QUESTION_LENGTH) {
      return {
        malformed: `question card "${id}" needs a "question" of 1 to ${MAX_QUESTION_LENGTH} characters`,
      }
    }

    if (raw.allowOther !== undefined && raw.allowOther !== true) {
      return {
        malformed: `question card "${id}" cannot switch "allowOther" off — the owner may always answer in their own words`,
      }
    }

    if (
      !Array.isArray(raw.options) ||
      raw.options.length < MIN_OPTIONS_PER_QUESTION ||
      raw.options.length > MAX_OPTIONS_PER_QUESTION
    ) {
      return {
        malformed: `question card "${id}" needs ${MIN_OPTIONS_PER_QUESTION} or ${MAX_OPTIONS_PER_QUESTION} options`,
      }
    }

    const options: ViviQuestionOption[] = []
    const labels = new Set<string>()
    let recommended = 0
    for (const rawOption of raw.options) {
      if (rawOption === null || typeof rawOption !== "object" || Array.isArray(rawOption)) {
        return { malformed: `every option of question card "${id}" must be a JSON object` }
      }
      const option = rawOption as { label?: unknown; recommended?: unknown }
      const label = typeof option.label === "string" ? oneLine(option.label) : ""
      if (label.length === 0 || label.length > MAX_OPTION_LABEL_LENGTH) {
        return {
          malformed: `every option of question card "${id}" needs a "label" of 1 to ${MAX_OPTION_LABEL_LENGTH} characters`,
        }
      }
      if (labels.has(label)) {
        return { malformed: `question card "${id}" offers "${label}" twice — every option must be distinct` }
      }
      labels.add(label)
      if (option.recommended !== undefined && typeof option.recommended !== "boolean") {
        return {
          malformed: `option "${label}" of question card "${id}" must mark "recommended" with true or false`,
        }
      }
      if (option.recommended === true) recommended += 1
      options.push(option.recommended === true ? { label, recommended: true } : { label })
    }
    if (recommended !== 1) {
      return {
        malformed: `question card "${id}" must mark exactly one option as recommended — this one marks ${recommended}`,
      }
    }

    // Recommended-first is settled once, here, so no renderer sorts and no answer index depends on a view: the owner always reads the senior default first.
    questions.push({
      id,
      question,
      options: [...options].sort((a, b) => Number(b.recommended ?? false) - Number(a.recommended ?? false)),
    })
  }
  return { questions }
}

export function stripQuestionsFence(reply: string): string {
  return stripFencedBlock(reply, QUESTIONS_TAG)
}

// The answered set is derived from the thread, never stored twice: a turn stamped with this stack's id retires exactly its own question.
export function remainingQuestions(
  stack: ViviQuestionStack,
  turns: readonly { answered?: ViviQuestionAnswerRef }[]
): ViviQuestion[] {
  const answered = new Set<string>()
  for (const turn of turns) {
    if (turn.answered?.stackId === stack.id) answered.add(turn.answered.questionId)
  }
  return stack.questions.filter((question) => !answered.has(question.id))
}

// A STANDING pile is a live object, not a past line: it renders after everything else so the card the owner must act on is always the last thing in the thread, never pushed off the top by its own answer lines. A spent pile stays where it happened (it renders as nothing at all).
export function threadRenderOrder(
  turns: readonly { questions?: ViviQuestionStack; answered?: ViviQuestionAnswerRef }[]
): number[] {
  const settled: number[] = []
  const standing: number[] = []
  turns.forEach((turn, index) => {
    const stack = turn.questions
    if (stack && remainingQuestions(stack, turns).length > 0) standing.push(index)
    else settled.push(index)
  })
  return [...settled, ...standing]
}

export function serializeAnswer(question: string, answer: string): string {
  return `${question}${ANSWER_SEPARATOR}${answer}`
}

function splitAnsweredLine(text: string): { question: string; answer: string } | null {
  const at = text.indexOf(ANSWER_SEPARATOR)
  if (at <= 0) return null
  return {
    question: text.slice(0, at),
    answer: text.slice(at + ANSWER_SEPARATOR.length),
  }
}

// The card it answers is the exact split, since a question of Vivi's may itself carry an arrow ("draft → review"); the separator search is only the fallback for a line whose stack is not in the loaded thread.
export function readAnsweredLine(
  turns: readonly { questions?: ViviQuestionStack }[],
  turn: { text: string; answered?: ViviQuestionAnswerRef }
): { question: string; answer: string } | null {
  const ref = turn.answered
  if (ref === undefined) return null
  const stack = turns.find((t) => t.questions?.id === ref.stackId)?.questions
  const question = stack?.questions.find((q) => q.id === ref.questionId)?.question
  if (question !== undefined) {
    const prefix = serializeAnswer(question, "")
    if (turn.text.startsWith(prefix)) return { question, answer: turn.text.slice(prefix.length) }
  }
  return splitAnsweredLine(turn.text)
}
