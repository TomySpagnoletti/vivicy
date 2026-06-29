import { describe, expect, it } from "vitest"

import {
  parseTranscript,
  transcriptName,
  transcriptUrl,
} from "@/lib/transcript"

describe("parseTranscript — Claude session JSONL", () => {
  const jsonl = [
    JSON.stringify({ type: "user", message: { content: "build the thing" } }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "let me plan" },
          { type: "tool_use", id: "t1", name: "Edit", input: { path: "a.ts" } },
          { type: "text", text: "done" },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    }),
  ].join("\n")

  it("detects the claude format and normalizes entries", () => {
    const { entries, format } = parseTranscript(jsonl)
    expect(format).toBe("claude")
    expect(entries.map((e) => e.kind)).toEqual([
      "user",
      "thinking",
      "tool",
      "assistant",
    ])
  })

  it("attaches tool output by tool_use_id and marks the final assistant", () => {
    const { entries } = parseTranscript(jsonl)
    const tool = entries.find((e) => e.kind === "tool")
    expect(tool).toMatchObject({ name: "Edit", output: "ok" })
    const assistant = entries.find((e) => e.kind === "assistant")
    expect(assistant).toMatchObject({ final: true })
  })
})

describe("parseTranscript — Codex rollout JSONL", () => {
  const jsonl = [
    JSON.stringify({ type: "session_meta", payload: {} }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "review it" } }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "reasoning", summary: [{ text: "thinking hard" }] },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", call_id: "c1", name: "shell", arguments: { cmd: "ls" } },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c1", output: { content: "files" } },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ text: "looks good" }] },
    }),
  ].join("\n")

  it("detects the codex format and normalizes entries", () => {
    const { entries, format } = parseTranscript(jsonl)
    expect(format).toBe("codex")
    expect(entries.map((e) => e.kind)).toEqual([
      "user",
      "thinking",
      "tool",
      "assistant",
    ])
    const tool = entries.find((e) => e.kind === "tool")
    expect(tool).toMatchObject({ name: "shell", output: "files" })
  })
})

describe("parseTranscript — edge cases", () => {
  it("returns unknown format and no entries for empty/garbage input", () => {
    expect(parseTranscript("")).toEqual({ entries: [], format: "unknown" })
    expect(parseTranscript("not json\n{bad")).toEqual({
      entries: [],
      format: "unknown",
    })
  })

  it("drops consecutive duplicate entries", () => {
    const dup = [
      JSON.stringify({ type: "user", message: { content: "same" } }),
      JSON.stringify({ type: "user", message: { content: "same" } }),
    ].join("\n")
    expect(parseTranscript(dup).entries).toHaveLength(1)
  })
})

describe("transcript url/name helpers", () => {
  it("builds an API url and strips leading slashes", () => {
    expect(transcriptUrl(".vivicy/development/transcripts/ISS-1/a.jsonl")).toBe(
      "/api/transcript/.vivicy/development/transcripts/ISS-1/a.jsonl"
    )
    expect(transcriptUrl("/leading/slash.jsonl")).toBe(
      "/api/transcript/leading/slash.jsonl"
    )
  })

  it("derives the file name from a ref", () => {
    expect(transcriptName(".vivicy/development/transcripts/ISS-1/claude.jsonl")).toBe(
      "claude.jsonl"
    )
  })
})
