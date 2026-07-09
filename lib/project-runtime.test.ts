import path from "node:path"

import { describe, expect, it } from "vitest"

import { getProjectRuntimeDir, projectRuntimeKey, PROJECTS_SUBDIR } from "@/lib/project-runtime"

describe("projectRuntimeKey", () => {
  it("is stable for the same absolute path and readable by a human", () => {
    const key = projectRuntimeKey("/tmp/My Cool-App")
    expect(key).toBe(projectRuntimeKey("/tmp/My Cool-App"))
    expect(key).toMatch(/^my-cool-app-[0-9a-f]{8}$/)
  })

  it("separates two targets sharing a basename (the collision case)", () => {
    expect(projectRuntimeKey("/a/app")).not.toBe(projectRuntimeKey("/b/app"))
    expect(projectRuntimeKey("/a/app").split("-").slice(0, -1).join("-")).toBe(
      projectRuntimeKey("/b/app").split("-").slice(0, -1).join("-")
    )
  })

  it("normalizes a relative path to its absolute form", () => {
    expect(projectRuntimeKey("foo")).toBe(projectRuntimeKey(path.resolve("foo")))
  })

  it("degrades a symbol-only basename to a usable slug", () => {
    expect(projectRuntimeKey("/tmp/###")).toMatch(/^project-[0-9a-f]{8}$/)
  })
})

describe("getProjectRuntimeDir", () => {
  it("nests the key under <root>/projects/", () => {
    const dir = getProjectRuntimeDir("/rt", "/tmp/demo")
    expect(dir).toBe(path.join("/rt", PROJECTS_SUBDIR, projectRuntimeKey("/tmp/demo")))
  })
})
