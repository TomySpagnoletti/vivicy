export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "assistant"; text: string; final?: boolean }
  | { kind: "tool"; name: string; input: string; output?: string }

export type TranscriptFormat = "claude" | "codex" | "unknown"

function asText(value: unknown): string {
  if (typeof value === "string") return value
  if (value == null) return ""
  return JSON.stringify(value, null, 2)
}

function msgText(p: Record<string, unknown>): string {
  return Array.isArray(p.content)
    ? (p.content as Record<string, unknown>[])
        .map((c) => (c.text as string) ?? "")
        .join("")
    : asText(p.content)
}

function reasoningText(p: Record<string, unknown>): string {
  const blocks = (p.summary ?? p.content) as Record<string, unknown>[] | undefined
  return Array.isArray(blocks)
    ? blocks.map((s) => (s.text as string) ?? "").join("\n\n")
    : asText(p.text)
}

function parseClaude(lines: Record<string, unknown>[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const toolById = new Map<string, Extract<TranscriptEntry, { kind: "tool" }>>()
  for (const o of lines) {
    const type = o.type as string
    const message = o.message as { content?: unknown } | undefined
    const content = message?.content
    if (type === "user") {
      if (typeof content === "string") {
        if (content.trim()) entries.push({ kind: "user", text: content })
      } else if (Array.isArray(content)) {
        for (const b of content as Record<string, unknown>[]) {
          if (b.type === "tool_result") {
            const tool = toolById.get(b.tool_use_id as string)
            if (tool) tool.output = asText(b.content)
          } else if (b.type === "text" && (b.text as string)?.trim()) {
            entries.push({ kind: "user", text: b.text as string })
          }
        }
      }
    } else if (type === "assistant" && Array.isArray(content)) {
      for (const b of content as Record<string, unknown>[]) {
        if (b.type === "thinking" && (b.thinking as string)?.trim()) {
          entries.push({ kind: "thinking", text: b.thinking as string })
        } else if (b.type === "text" && (b.text as string)?.trim()) {
          entries.push({ kind: "assistant", text: b.text as string })
        } else if (b.type === "tool_use") {
          const tool = {
            kind: "tool" as const,
            name: (b.name as string) ?? "tool",
            input: asText(b.input),
          }
          entries.push(tool)
          if (b.id) toolById.set(b.id as string, tool)
        }
      }
    }
  }
  return entries
}

function parseCodex(lines: Record<string, unknown>[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const toolById = new Map<string, Extract<TranscriptEntry, { kind: "tool" }>>()
  const riHasReasoning = lines.some(
    (o) =>
      o.type === "response_item" &&
      (o.payload as Record<string, unknown>)?.type === "reasoning" &&
      reasoningText(o.payload as Record<string, unknown>).trim()
  )
  const riHasAssistant = lines.some(
    (o) =>
      o.type === "response_item" &&
      (o.payload as Record<string, unknown>)?.type === "message" &&
      (o.payload as Record<string, unknown>).role === "assistant" &&
      msgText(o.payload as Record<string, unknown>).trim()
  )
  for (const o of lines) {
    const p = o.payload as Record<string, unknown> | undefined
    if (!p) continue
    if (o.type === "event_msg") {
      if (p.type === "user_message" && (p.message as string)?.trim())
        entries.push({ kind: "user", text: p.message as string })
      else if (p.type === "reasoning" && !riHasReasoning && reasoningText(p).trim())
        entries.push({ kind: "thinking", text: reasoningText(p) })
      else if (
        p.type === "agent_message" &&
        !riHasAssistant &&
        (p.message as string)?.trim()
      )
        entries.push({ kind: "assistant", text: p.message as string })
      continue
    }
    if (o.type !== "response_item") continue
    if (p.type === "message") {
      const text = msgText(p)
      if (!text.trim()) continue
      if (p.role === "user") continue
      entries.push({ kind: "assistant", text })
    } else if (p.type === "reasoning") {
      const text = reasoningText(p)
      if (text.trim()) entries.push({ kind: "thinking", text })
    } else if (p.type === "function_call") {
      const tool = {
        kind: "tool" as const,
        name: (p.name as string) ?? "tool",
        input: asText(p.arguments),
      }
      entries.push(tool)
      const id = (p.call_id ?? p.id) as string | undefined
      if (id) toolById.set(id, tool)
    } else if (p.type === "function_call_output") {
      const id = (p.call_id ?? p.id) as string | undefined
      const tool = id ? toolById.get(id) : undefined
      if (tool)
        tool.output = asText(
          (p.output as { content?: unknown })?.content ?? p.output
        )
    }
  }
  return entries
}

export function parseTranscript(jsonl: string): {
  entries: TranscriptEntry[]
  format: TranscriptFormat
} {
  const lines: Record<string, unknown>[] = []
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    try {
      lines.push(JSON.parse(line))
    } catch {
    }
  }
  const isCodex = lines.some(
    (o) => o.type === "session_meta" || o.type === "response_item"
  )
  const isClaude = lines.some((o) => o.type === "assistant" || o.type === "user")
  const format: TranscriptFormat = isCodex
    ? "codex"
    : isClaude
      ? "claude"
      : "unknown"
  const raw =
    format === "codex"
      ? parseCodex(lines)
      : format === "claude"
        ? parseClaude(lines)
        : []
  // Drop consecutive duplicates (Codex emits user_message twice, etc.).
  const entries: TranscriptEntry[] = []
  for (const e of raw) {
    const prev = entries[entries.length - 1]
    const sameText =
      prev &&
      prev.kind === e.kind &&
      "text" in prev &&
      "text" in e &&
      (prev as { text: string }).text === (e as { text: string }).text
    const sameTool =
      prev &&
      prev.kind === "tool" &&
      e.kind === "tool" &&
      prev.name === e.name &&
      prev.input === e.input
    if (sameText || sameTool) continue
    entries.push(e)
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].kind === "assistant") {
      ;(entries[i] as Extract<TranscriptEntry, { kind: "assistant" }>).final = true
      break
    }
  }
  return { entries, format }
}

export function transcriptUrl(ref: string): string {
  return `/api/transcript/${ref.replace(/^\/+/, "")}`
}

export function transcriptName(ref: string): string {
  return ref.split("/").slice(-1)[0] ?? ref
}
