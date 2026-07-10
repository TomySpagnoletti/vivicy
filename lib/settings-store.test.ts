import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/settings"
import { getSettingsPath, readSettings, writeSettings } from "@/lib/settings-store"

let runtimeDir: string
let prevEnv: string | undefined

beforeEach(() => {
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivicy-settings-store-"))
  prevEnv = process.env.VIVICY_RUNTIME_DIR
  process.env.VIVICY_RUNTIME_DIR = runtimeDir
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env.VIVICY_RUNTIME_DIR
  else process.env.VIVICY_RUNTIME_DIR = prevEnv
  rmSync(runtimeDir, { recursive: true, force: true })
})

describe("getSettingsPath", () => {
  it("points at settings.json inside the runtime dir", () => {
    expect(getSettingsPath()).toBe(path.join(runtimeDir, "settings.json"))
  })
})

describe("readSettings", () => {
  it("returns the defaults when the file is absent (no file written)", () => {
    expect(existsSync(getSettingsPath())).toBe(false)
    expect(readSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it("returns the defaults on a corrupt (non-JSON) file", () => {
    writeFileSync(getSettingsPath(), "{ not valid json ::")
    expect(readSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it("normalizes a present-but-partial file (fills missing fields, repairs bad ones)", () => {
    writeFileSync(
      getSettingsPath(),
      JSON.stringify({
        implementer: { provider: "claude", model: "claude-opus-4-8", effort: "extreme" },
      })
    )
    const read = readSettings()
    expect(read).toEqual(
      normalizeSettings({
        implementer: { provider: "claude", model: "claude-opus-4-8", effort: "extreme" },
      })
    )
    expect(read.implementer.effort).toBe(DEFAULT_SETTINGS.implementer.effort)
    expect(read.reviewer).toBeDefined()
  })

  it("normalizes a valid present file and keeps its valid choices", () => {
    const doc = normalizeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "max", fast: true },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "low", fast: false },
    })
    writeFileSync(getSettingsPath(), JSON.stringify(doc))
    expect(readSettings()).toEqual(doc)
  })
})

describe("writeSettings", () => {
  it("normalizes the input, returns the normalized document, and round-trips through readSettings", () => {
    const written = writeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "max", fast: true },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "low", fast: false },
    })
    expect(written).toEqual(
      normalizeSettings({
        implementer: { provider: "claude", model: "claude-opus-4-8", effort: "max", fast: true },
        reviewer: { provider: "codex", model: "gpt-5.5", effort: "low", fast: false },
      })
    )
    expect(existsSync(getSettingsPath())).toBe(true)
    expect(readSettings()).toEqual(written)
  })

  it("returns the normalized document, never the raw (invalid) input", () => {
    const written = writeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "extreme" },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "minimal" },
    })
    expect(written.implementer.effort).not.toBe("extreme")
    expect(written.implementer.effort).toBe(DEFAULT_SETTINGS.implementer.effort)
    const onDisk = JSON.parse(readFileSync(getSettingsPath(), "utf8"))
    expect(onDisk).toEqual(written)
  })

  it("creates the runtime dir on demand and writes a trailing-newline-terminated file", () => {
    rmSync(runtimeDir, { recursive: true, force: true })
    expect(existsSync(runtimeDir)).toBe(false)
    writeSettings(DEFAULT_SETTINGS)
    expect(existsSync(runtimeDir)).toBe(true)
    expect(readFileSync(getSettingsPath(), "utf8").endsWith("}\n")).toBe(true)
  })

  it("normalizes a completely empty input to the full default-shaped document", () => {
    const written = writeSettings({})
    expect(written).toEqual(normalizeSettings({}))
    expect(readSettings()).toEqual(written)
  })
})
