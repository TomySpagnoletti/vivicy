import { describe, expect, it } from "vitest"

import {
  commandServesHttp,
  detectPortFromCommand,
  detectUrlFromLog,
  deriveProductRunUrl,
  normalizeRunCommandValue,
} from "@/lib/product-run"

describe("detectUrlFromLog", () => {
  it("sniffs the URL a dev server prints, taking the most recent match", () => {
    expect(detectUrlFromLog("  VITE ready\n  ➜  Local:   http://localhost:5173/\n")).toBe(
      "http://localhost:5173/"
    )
    expect(detectUrlFromLog("listening on http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000")
    expect(
      detectUrlFromLog("http://localhost:3000\n... restarted ...\nhttp://localhost:3100")
    ).toBe("http://localhost:3100")
  })

  it("normalizes a bind-all address to a browsable localhost", () => {
    expect(detectUrlFromLog("Server running at http://0.0.0.0:4000/")).toBe(
      "http://localhost:4000/"
    )
    expect(detectUrlFromLog("http://[::]:9090")).toBe("http://localhost:9090")
  })

  it("strips trailing punctuation the log wrapped around the URL", () => {
    expect(detectUrlFromLog("open http://localhost:3000).")).toBe("http://localhost:3000")
  })

  it("ignores non-loopback hosts (never surfaces an arbitrary printed host)", () => {
    expect(detectUrlFromLog("proxied from https://api.example.com/v1")).toBeNull()
    expect(detectUrlFromLog("no url here at all")).toBeNull()
  })
})

describe("detectPortFromCommand", () => {
  it("reads a port from the common dev-server flag shapes", () => {
    expect(detectPortFromCommand("next dev --port 3001")).toBe(3001)
    expect(detectPortFromCommand("vite --port=5174")).toBe(5174)
    expect(detectPortFromCommand("node server.js -p 8080")).toBe(8080)
    expect(detectPortFromCommand("PORT=4000 npm start")).toBe(4000)
  })

  it("returns null when no port is stated or it is out of range", () => {
    expect(detectPortFromCommand("npm run dev")).toBeNull()
    expect(detectPortFromCommand("serve --port 99999")).toBeNull()
  })
})

describe("deriveProductRunUrl", () => {
  it("prefers the authoritative log URL over the command-string port", () => {
    expect(deriveProductRunUrl("Local: http://localhost:5173/", "vite --port 3000")).toEqual({
      url: "http://localhost:5173/",
      source: "log",
    })
  })

  it("falls back to the command port when the log has no URL yet", () => {
    expect(deriveProductRunUrl("compiling...", "next dev --port 3001")).toEqual({
      url: "http://localhost:3001",
      source: "command",
    })
  })

  it("honestly returns no URL (see-log fallback) when neither heuristic fires", () => {
    expect(deriveProductRunUrl("building the bundle", "python worker.py")).toEqual({
      url: null,
      source: null,
    })
    expect(deriveProductRunUrl(null, null)).toEqual({ url: null, source: null })
  })
})

describe("commandServesHttp", () => {
  it("fires for a browser-facing run command — framework dev-server, node run convention, or explicit http port", () => {
    expect(commandServesHttp("next dev")).toBe(true)
    expect(commandServesHttp("vite")).toBe(true)
    expect(commandServesHttp("flask run")).toBe(true)
    expect(commandServesHttp("bin/rails server")).toBe(true)
    expect(commandServesHttp("php -S localhost:8000")).toBe(true)
    expect(commandServesHttp("npm run dev")).toBe(true)
    expect(commandServesHttp("pnpm start")).toBe(true)
    expect(commandServesHttp("node server.js --port 8080")).toBe(true)
  })

  it("stays off (byte-identical non-UI reviewer) for a compiled/CLI run command or a blank value", () => {
    expect(commandServesHttp("go run ./...")).toBe(false)
    expect(commandServesHttp("cargo run")).toBe(false)
    expect(commandServesHttp("python worker.py")).toBe(false)
    expect(commandServesHttp("java -jar app.jar")).toBe(false)
    expect(commandServesHttp("   ")).toBe(false)
    expect(commandServesHttp(null)).toBe(false)
  })
})

describe("normalizeRunCommandValue", () => {
  it("treats the null sentinel / blank / non-string as not-established", () => {
    expect(normalizeRunCommandValue(null)).toBeNull()
    expect(normalizeRunCommandValue("   ")).toBeNull()
    expect(normalizeRunCommandValue(42)).toBeNull()
    expect(normalizeRunCommandValue("  npm run dev  ")).toBe("npm run dev")
  })
})
