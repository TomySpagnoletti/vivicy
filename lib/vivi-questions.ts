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

// Never store an answer here: the thread is the single store, and an answer is an ordinary user turn.
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

// Refuse on SIZE before parsing or normalizing: a leg reply is an untrusted-length boundary.
const MAX_FENCE_BODY_LENGTH = 16_384

// Wire separator of the serialized question→answer line: the server composes with it and the panel splits on it — move both or neither.
export const ANSWER_SEPARATOR = " → "

const QUESTION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export type QuestionsDirective = { questions: ViviQuestion[] } | { malformed: string } | null

// Strip BEFORE the whitespace collapse, and never widen this class: U+2028/2029 must survive to collapse into a space, the joiners U+200C/200D change what renders, and `\p{Cf}` wholesale would eat U+0600-0605.
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g

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

    if (!Array.isArray(raw.options) || raw.options.length < MIN_OPTIONS_PER_QUESTION || raw.options.length > MAX_OPTIONS_PER_QUESTION) {
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

    // Sort recommended-first ONCE, here: no renderer may re-sort, and no answer may depend on a view's order.
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

export function remainingQuestions(stack: ViviQuestionStack, turns: readonly { answered?: ViviQuestionAnswerRef }[]): ViviQuestion[] {
  const answered = new Set<string>()
  for (const turn of turns) {
    if (turn.answered?.stackId === stack.id) answered.add(turn.answered.questionId)
  }
  return stack.questions.filter((question) => !answered.has(question.id))
}

export function threadRenderOrder(turns: readonly { questions?: ViviQuestionStack; answered?: ViviQuestionAnswerRef }[]): number[] {
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

// Prefer the exact ref split: a question may itself carry the arrow separator, so the indexOf search is only a fallback.
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
