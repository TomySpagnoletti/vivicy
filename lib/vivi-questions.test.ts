import { describe, expect, it } from "vitest"

import {
  ANSWER_SEPARATOR,
  MAX_QUESTIONS_PER_STACK,
  parseQuestionsDirective,
  readAnsweredLine,
  remainingQuestions,
  serializeAnswer,
  stripQuestionsFence,
  threadRenderOrder,
  type ViviQuestionStack,
} from "@/lib/vivi-questions"

function fenced(json: string, lead = "Allora, three things and we can move on."): string {
  return `${lead}\n\n\`\`\`vivicy-questions\n${json}\n\`\`\``
}

function card(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "datastore",
    question: "Which datastore should v1 run on?",
    options: [{ label: "SQLite" }, { label: "Postgres", recommended: true }],
    allowOther: true,
    ...over,
  }
}

function malformed(json: string): string {
  const directive = parseQuestionsDirective(fenced(json))
  if (directive === null || !("malformed" in directive)) {
    throw new Error(`expected a refusal, got ${JSON.stringify(directive)}`)
  }
  return directive.malformed
}

describe("parseQuestionsDirective — the validated fence", () => {
  it("returns null when the reply carries no vivicy-questions block", () => {
    expect(parseQuestionsDirective("just a normal reply")).toBeNull()
    expect(parseQuestionsDirective('```json\n[{"id":"a"}]\n```')).toBeNull()
  })

  it("parses a well-formed stack, normalizes whitespace, and puts the recommended option FIRST", () => {
    const directive = parseQuestionsDirective(
      fenced(
        JSON.stringify([
          card({
            question: "  Which datastore\n  should v1 run on?  ",
            options: [
              { label: "SQLite" },
              { label: "  Postgres  ", recommended: true },
              { label: "MongoDB" },
            ],
          }),
        ])
      )
    )
    expect(directive).toEqual({
      questions: [
        {
          id: "datastore",
          question: "Which datastore should v1 run on?",
          options: [{ label: "Postgres", recommended: true }, { label: "SQLite" }, { label: "MongoDB" }],
        },
      ],
    })
  })

  it("keeps the alternatives in the order she wrote them", () => {
    const directive = parseQuestionsDirective(
      fenced(
        JSON.stringify([
          card({
            options: [{ label: "MongoDB" }, { label: "SQLite" }, { label: "Postgres", recommended: true }],
          }),
        ])
      )
    )
    expect(directive).toMatchObject({
      questions: [{ options: [{ label: "Postgres" }, { label: "MongoDB" }, { label: "SQLite" }] }],
    })
  })

  it("refuses invalid JSON instead of throwing", () => {
    expect(malformed('[{"id": "a",}]')).toBe("the vivicy-questions block is not valid JSON")
  })

  it("refuses an oversized body on SIZE, before it is parsed or normalized", () => {
    const huge = JSON.stringify([card({ question: "q".repeat(20_000) })])
    expect(malformed(huge)).toBe(
      `the vivicy-questions block runs to ${huge.length} characters — one stack takes at most 16384`
    )
  })

  it("strips the invisible characters that would make a label read as one thing and record as another", () => {
    const spoof = "Post​gres‮ ⁦self-hosted⁩"
    const directive = parseQuestionsDirective(
      fenced(JSON.stringify([card({ options: [{ label: spoof, recommended: true }, { label: "SQLite" }] })]))
    )
    expect(directive).toMatchObject({
      questions: [{ options: [{ label: "Postgres self-hosted" }, { label: "SQLite" }] }],
    })
  })

  it("leaves ONE space where an invisible sat between two whitespace runs, never the double it hides", () => {
    const directive = parseQuestionsDirective(
      fenced(JSON.stringify([card({ question: "Ship it \u200B now, or wait \u202E for v2?" })]))
    )
    expect(directive).toMatchObject({ questions: [{ question: "Ship it now, or wait for v2?" }] })
  })

  it("closes up around an invisible with no whitespace to keep, since it renders as nothing", () => {
    const directive = parseQuestionsDirective(
      fenced(JSON.stringify([card({ question: "one\ttwo\u200Bthree\nfour\uFEFFfive" })]))
    )
    expect(directive).toMatchObject({ questions: [{ question: "one twothree fourfive" }] })
  })

  it("keeps the word break a LINE SEPARATOR carries — it renders as a break, so it collapses instead of vanishing", () => {
    const directive = parseQuestionsDirective(
      fenced(JSON.stringify([card({ question: "one\u2028two\u2029three" })]))
    )
    expect(directive).toMatchObject({ questions: [{ question: "one two three" }] })
  })

  // ZWJ/ZWNJ are not invisible — they are what makes these one glyph, one word, one cluster. `oneLine` also governs the owner's own typed answer, so stripping them would break "an answer is strictly equivalent to typing it".
  it.each([
    ["family emoji (ZWJ)", "Un Raspberry Pi chez moi \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67"],
    ["Persian mi-ravad (ZWNJ)", "\u0645\u06CC\u200C\u0631\u0648\u062F"],
    ["Devanagari k-ssa (ZWJ)", "\u0915\u094D\u200D\u0937"],
    ["rainbow flag (ZWJ)", "\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08"],
  ])("carries a joiner through a question and a label byte-identical: %s", (_name, text) => {
    const directive = parseQuestionsDirective(
      fenced(JSON.stringify([card({ question: text, options: [{ label: text, recommended: true }, { label: "autre" }] })]))
    )
    expect(directive).toMatchObject({ questions: [{ question: text, options: [{ label: text }, { label: "autre" }] }] })
  })

  it("still strips the spoof characters that a joiner exemption must not smuggle back in", () => {
    const directive = parseQuestionsDirective(
      fenced(
        JSON.stringify([
          card({
            question: "Post\u200Bgres\u202E \u2066(managed)\u2069?",
            options: [{ label: "a\u200Eb\u200Fc", recommended: true }, { label: "SQLite\u00ADon\uFEFFdisk" }],
          }),
        ])
      )
    )
    expect(directive).toMatchObject({
      questions: [{ question: "Postgres (managed)?", options: [{ label: "abc" }, { label: "SQLiteondisk" }] }],
    })
  })

  it("leaves an Arabic number sign alone — it carries meaning, unlike the zero-width family", () => {
    const directive = parseQuestionsDirective(
      fenced(JSON.stringify([card({ question: "Budget ؀100 ?" })]))
    )
    expect(directive).toMatchObject({ questions: [{ question: "Budget ؀100 ?" }] })
  })

  it("refuses a non-array, an empty array, and an over-cap stack", () => {
    expect(malformed('{"questions": []}')).toContain("must be a JSON array holding at least one")
    expect(malformed("[]")).toContain("must be a JSON array holding at least one")
    const over = Array.from({ length: MAX_QUESTIONS_PER_STACK + 1 }, (_, i) => card({ id: `q${i}` }))
    expect(malformed(JSON.stringify(over))).toBe(
      `the vivicy-questions block holds ${MAX_QUESTIONS_PER_STACK + 1} question cards — one stack takes at most ${MAX_QUESTIONS_PER_STACK}`
    )
  })

  it("refuses a bad, missing, over-long, or duplicated id", () => {
    expect(malformed(JSON.stringify([card({ id: "" })]))).toContain('needs an "id"')
    expect(malformed(JSON.stringify([card({ id: "../escape" })]))).toContain('needs an "id"')
    expect(malformed(JSON.stringify([card({ id: "x".repeat(41) })]))).toContain('needs an "id"')
    expect(malformed(JSON.stringify([card(), card()]))).toBe(
      'two question cards share the id "datastore" — every id in a stack must be unique'
    )
  })

  it("refuses an empty, non-string, or over-long question", () => {
    expect(malformed(JSON.stringify([card({ question: "   " })]))).toContain('needs a "question"')
    expect(malformed(JSON.stringify([card({ question: 7 })]))).toContain('needs a "question"')
    expect(malformed(JSON.stringify([card({ question: "q".repeat(201) })]))).toContain('needs a "question"')
  })

  it("refuses an option count outside 2–3, a non-object option, and an over-long or repeated label", () => {
    expect(malformed(JSON.stringify([card({ options: [{ label: "only", recommended: true }] })]))).toBe(
      'question card "datastore" needs 2 or 3 options'
    )
    expect(
      malformed(
        JSON.stringify([
          card({
            options: [
              { label: "a", recommended: true },
              { label: "b" },
              { label: "c" },
              { label: "d" },
            ],
          }),
        ])
      )
    ).toBe('question card "datastore" needs 2 or 3 options')
    expect(malformed(JSON.stringify([card({ options: ["Postgres", "SQLite"] })]))).toContain(
      "must be a JSON object"
    )
    expect(
      malformed(JSON.stringify([card({ options: [{ label: "x".repeat(81), recommended: true }, { label: "b" }] })]))
    ).toContain('needs a "label"')
    expect(
      malformed(JSON.stringify([card({ options: [{ label: "Same", recommended: true }, { label: "Same" }] })]))
    ).toBe('question card "datastore" offers "Same" twice — every option must be distinct')
  })

  it("refuses zero, several, or non-boolean recommendations — exactly one is the law", () => {
    expect(malformed(JSON.stringify([card({ options: [{ label: "a" }, { label: "b" }] })]))).toBe(
      'question card "datastore" must mark exactly one option as recommended — this one marks 0'
    )
    expect(
      malformed(
        JSON.stringify([card({ options: [{ label: "a", recommended: true }, { label: "b", recommended: true }] })])
      )
    ).toBe('question card "datastore" must mark exactly one option as recommended — this one marks 2')
    expect(
      malformed(JSON.stringify([card({ options: [{ label: "a", recommended: "yes" }, { label: "b" }] })]))
    ).toContain('must mark "recommended" with true or false')
  })

  it("refuses a card trying to switch the free answer off, and accepts its absence", () => {
    expect(malformed(JSON.stringify([card({ allowOther: false })]))).toBe(
      'question card "datastore" cannot switch "allowOther" off — the owner may always answer in their own words'
    )
    const absent = { ...card() }
    delete absent.allowOther
    expect(parseQuestionsDirective(fenced(JSON.stringify([absent])))).toMatchObject({
      questions: [{ id: "datastore" }],
    })
  })

  it("refuses the WHOLE stack when one card is bad — never half a pile", () => {
    const directive = parseQuestionsDirective(
      fenced(JSON.stringify([card(), card({ id: "auth", options: [{ label: "a" }, { label: "b" }] })]))
    )
    expect(directive).toEqual({
      malformed: 'question card "auth" must mark exactly one option as recommended — this one marks 0',
    })
  })
})

describe("stripQuestionsFence — the block never reaches the thread", () => {
  it("removes the fence and collapses the hole it leaves", () => {
    expect(stripQuestionsFence(fenced(JSON.stringify([card()]), "Two things."))).toBe("Two things.")
  })

  it("leaves a reply with no fence byte-identical", () => {
    expect(stripQuestionsFence("nothing to strip")).toBe("nothing to strip")
  })
})

describe("remainingQuestions — the pile derived from the thread", () => {
  const stack: ViviQuestionStack = {
    id: "stack-1",
    questions: [
      { id: "a", question: "A?", options: [{ label: "1", recommended: true }, { label: "2" }] },
      { id: "b", question: "B?", options: [{ label: "1", recommended: true }, { label: "2" }] },
    ],
  }

  it("counts every question standing when nothing is answered", () => {
    expect(remainingQuestions(stack, [{}, {}])).toHaveLength(2)
  })

  it("retires exactly the answered question, ignoring another stack's answers", () => {
    const turns = [
      { answered: { stackId: "stack-1", questionId: "a" } },
      { answered: { stackId: "other", questionId: "b" } },
    ]
    expect(remainingQuestions(stack, turns).map((q) => q.id)).toEqual(["b"])
  })

  it("is idempotent under a replayed answer line", () => {
    const twice = [
      { answered: { stackId: "stack-1", questionId: "a" } },
      { answered: { stackId: "stack-1", questionId: "a" } },
    ]
    expect(remainingQuestions(stack, twice).map((q) => q.id)).toEqual(["b"])
  })
})

describe("threadRenderOrder — a standing pile is the last thing in the thread", () => {
  const stack: ViviQuestionStack = {
    id: "stack-1",
    questions: [
      { id: "a", question: "A?", options: [{ label: "1", recommended: true }, { label: "2" }] },
      { id: "b", question: "B?", options: [{ label: "1", recommended: true }, { label: "2" }] },
    ],
  }

  it("leaves an untouched thread in its own order", () => {
    expect(threadRenderOrder([{}, {}, {}])).toEqual([0, 1, 2])
  })

  it("moves a standing pile below the answers it has already taken", () => {
    const turns = [{}, { questions: stack }, { answered: { stackId: "stack-1", questionId: "a" } }]
    expect(threadRenderOrder(turns)).toEqual([0, 2, 1])
  })

  it("leaves a spent pile where it happened", () => {
    const turns = [
      { questions: stack },
      { answered: { stackId: "stack-1", questionId: "a" } },
      { answered: { stackId: "stack-1", questionId: "b" } },
      {},
    ]
    expect(threadRenderOrder(turns)).toEqual([0, 1, 2, 3])
  })

  it("keeps two standing piles in their own order, both after everything settled", () => {
    const other: ViviQuestionStack = { ...stack, id: "stack-2" }
    const turns = [{ questions: stack }, {}, { questions: other }, {}]
    expect(threadRenderOrder(turns)).toEqual([1, 3, 0, 2])
  })
})

describe("the serialized Q+A line", () => {
  const stray = { answered: { stackId: "gone", questionId: "gone" } }

  it("round-trips through the one separator, read back with no stack in reach", () => {
    const line = serializeAnswer("Which datastore should v1 run on?", "Postgres")
    expect(line).toBe(`Which datastore should v1 run on?${ANSWER_SEPARATOR}Postgres`)
    expect(readAnsweredLine([], { text: line, ...stray })).toEqual({
      question: "Which datastore should v1 run on?",
      answer: "Postgres",
    })
  })

  it("falls back to the FIRST separator, so an arrow inside the answer survives", () => {
    const line = serializeAnswer("Flow?", "draft → review → live")
    expect(readAnsweredLine([], { text: line, ...stray })).toEqual({
      question: "Flow?",
      answer: "draft → review → live",
    })
  })

  it("reads null for a line that carries no separator at all", () => {
    expect(readAnsweredLine([], { text: "an ordinary typed message", ...stray })).toBeNull()
  })
})

describe("readAnsweredLine — the card it answers is the exact split", () => {
  const arrowStack: ViviQuestionStack = {
    id: "stack-1",
    questions: [
      {
        id: "flow",
        question: "Which flow: draft → live, or draft → review → live?",
        options: [{ label: "draft → review → live", recommended: true }, { label: "draft → live" }],
      },
    ],
  }
  const turns = [{ questions: arrowStack }]
  const line = {
    text: serializeAnswer(arrowStack.questions[0].question, "draft → live"),
    answered: { stackId: "stack-1", questionId: "flow" },
  }

  it("splits on the card's own question, not on the first arrow in it", () => {
    expect(readAnsweredLine(turns, line)).toEqual({
      question: "Which flow: draft → live, or draft → review → live?",
      answer: "draft → live",
    })
    expect(readAnsweredLine([], line)).not.toEqual(readAnsweredLine(turns, line))
  })

  it("falls back to the separator when the stack is not in the loaded thread", () => {
    expect(readAnsweredLine([], line)).toEqual({
      question: "Which flow: draft",
      answer: "live, or draft → review → live? → draft → live",
    })
  })

  it("is null for a turn that answers no card", () => {
    expect(readAnsweredLine(turns, { text: "an ordinary typed message" })).toBeNull()
  })
})
