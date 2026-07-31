import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { TRANSLATED_NOTIFICATION_EVENTS, UNTRANSLATED_NOTIFICATION_EVENTS, translatedNotificationParams } from "@/lib/notification-events"
import { VIVI_ACTION_TOOLS, viviActionEvent } from "@/lib/vivi-actions"
import notifications from "@/messages/en/notifications.json"

const REPO_ROOT = path.resolve(__dirname, "..")
const WRITER_DIRS = ["app", "components", "factory", "lib"]
const DECLARATION_FILE = path.join(REPO_ROOT, "lib", "notification-events.ts")

function declaredPairs(): Array<{ stage: string; event: string; params: readonly string[] }> {
  return Object.entries(TRANSLATED_NOTIFICATION_EVENTS).flatMap(([stage, events]) =>
    Object.entries(events).map(([event, params]) => ({ stage, event, params: params as readonly string[] }))
  )
}

function untranslatedPairs(): Array<{ stage: string; event: string }> {
  return Object.entries(UNTRANSLATED_NOTIFICATION_EVENTS).flatMap(([stage, events]) => events.map((event) => ({ stage, event })))
}

function cataloguePairs(): Array<{ stage: string; event: string; copy: string }> {
  return Object.entries(notifications.events as Record<string, Record<string, string>>).flatMap(([stage, events]) =>
    Object.entries(events).map(([event, copy]) => ({ stage, event, copy }))
  )
}

function placeholders(copy: string): string[] {
  return [...copy.matchAll(/\{\s*(\w+)/g)].map((match) => match[1]).sort()
}

function writerSources(): string {
  const chunks: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || abs === DECLARATION_FILE) continue
      chunks.push(readFileSync(abs, "utf8"))
    }
  }
  for (const dir of WRITER_DIRS) walk(path.join(REPO_ROOT, dir))
  return chunks.join("\n")
}

describe("notification catalogue parity (the declared emitter set is the one truth both sides answer to)", () => {
  it("every catalogue key names a declared emitted event — a key no writer can reach is dead copy", () => {
    const orphans = cataloguePairs()
      .filter(({ stage, event }) => translatedNotificationParams(stage, event) === null)
      .map(({ stage, event }) => `${stage}.${event}`)

    expect(orphans).toEqual([])
  })

  it("every declared translated event has a catalogue key — a writer shipping keyless is a hole, not a degradation", () => {
    const keyed = new Set(cataloguePairs().map(({ stage, event }) => `${stage}.${event}`))
    const missing = declaredPairs()
      .map(({ stage, event }) => `${stage}.${event}`)
      .filter((key) => !keyed.has(key))

    expect(missing).toEqual([])
  })

  it("every value a key interpolates is declared, and every declared value is interpolated", () => {
    const drift = cataloguePairs()
      .map(({ stage, event, copy }) => ({
        key: `${stage}.${event}`,
        copy: placeholders(copy),
        declared: [...(translatedNotificationParams(stage, event) ?? [])].sort(),
      }))
      .filter(({ copy, declared }) => copy.join(",") !== declared.join(","))

    expect(drift).toEqual([])
  })

  it("an untranslated event carries no key, and no event is declared on both sides", () => {
    const keyed = new Set(cataloguePairs().map(({ stage, event }) => `${stage}.${event}`))
    const shadowed = untranslatedPairs()
      .map(({ stage, event }) => `${stage}.${event}`)
      .filter((key) => keyed.has(key))

    expect(shadowed).toEqual([])
    expect(untranslatedPairs().filter(({ stage, event }) => translatedNotificationParams(stage, event) !== null)).toEqual([])
  })

  it("every declared event id is spelled by a live writer — a key outliving its emitter goes red here", () => {
    const derived = new Set(VIVI_ACTION_TOOLS.map(viviActionEvent))
    const sources = writerSources()
    const unspoken = [...declaredPairs(), ...untranslatedPairs()]
      .map(({ event }) => event)
      .filter((event) => !derived.has(event as ReturnType<typeof viviActionEvent>) && !sources.includes(event))

    expect(unspoken).toEqual([])
  })

  it("the per-tool Vivi events are exactly the ones the action registry can emit", () => {
    const declared = Object.keys(TRANSLATED_NOTIFICATION_EVENTS.vivi)
      .filter((event) => event !== "action_unknown_error")
      .sort()

    expect(declared).toEqual(VIVI_ACTION_TOOLS.map(viviActionEvent).sort())
  })
})
