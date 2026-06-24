import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { FsBrowseError, listDirectories, resolveBrowsePath } from "@/lib/fs-browser"

let root: string

beforeEach(() => {
  // realpath the temp root: on macOS /tmp is a symlink to /private/tmp, and the
  // browser canonicalizes paths, so the assertions must compare against the real
  // path the OS resolves to.
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "vivicy-fs-")))
  mkdirSync(path.join(root, "alpha"))
  mkdirSync(path.join(root, "beta"))
  mkdirSync(path.join(root, ".hidden"))
  writeFileSync(path.join(root, "a-file.txt"), "x")
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("resolveBrowsePath (path-safety)", () => {
  it("rejects a relative path with not_absolute", () => {
    try {
      resolveBrowsePath("relative/dir")
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(FsBrowseError)
      expect((error as FsBrowseError).code).toBe("not_absolute")
    }
  })

  it("rejects a non-existent absolute path with not_found", () => {
    try {
      resolveBrowsePath(path.join(root, "nope"))
      expect.unreachable("should have thrown")
    } catch (error) {
      expect((error as FsBrowseError).code).toBe("not_found")
    }
  })

  it("rejects a file with not_a_directory", () => {
    try {
      resolveBrowsePath(path.join(root, "a-file.txt"))
      expect.unreachable("should have thrown")
    } catch (error) {
      expect((error as FsBrowseError).code).toBe("not_a_directory")
    }
  })

  it("collapses traversal segments to the real target", () => {
    // root/alpha/../beta normalizes to root/beta — a valid directory, not an escape.
    const resolved = resolveBrowsePath(path.join(root, "alpha", "..", "beta"))
    expect(resolved).toBe(path.join(root, "beta"))
  })

  it("rejects a traversal that lands on a non-existent path", () => {
    try {
      resolveBrowsePath(path.join(root, "alpha", "..", "..", "definitely-not-here-xyz"))
      expect.unreachable("should have thrown")
    } catch (error) {
      expect((error as FsBrowseError).code).toBe("not_found")
    }
  })

  it("resolves a symlinked directory to its canonical location", () => {
    const link = path.join(root, "link-to-alpha")
    symlinkSync(path.join(root, "alpha"), link)
    expect(resolveBrowsePath(link)).toBe(path.join(root, "alpha"))
  })

  it("falls back to the default root (home) for empty input", () => {
    // Empty input resolves to the real home dir; assert it's an absolute dir path.
    const resolved = resolveBrowsePath("")
    expect(path.isAbsolute(resolved)).toBe(true)
  })
})

describe("listDirectories", () => {
  it("lists only subdirectories, sorted, omitting files and dotfiles", () => {
    const listing = listDirectories(root)
    expect(listing.path).toBe(root)
    expect(listing.entries.map((e) => e.name)).toEqual(["alpha", "beta"])
    // Files and dotfiles are excluded.
    expect(listing.entries.some((e) => e.name === "a-file.txt")).toBe(false)
    expect(listing.entries.some((e) => e.name === ".hidden")).toBe(false)
    // Entry paths are absolute children of the listed dir.
    expect(listing.entries[0].path).toBe(path.join(root, "alpha"))
  })

  it("surfaces a parent for a non-root directory", () => {
    const listing = listDirectories(path.join(root, "alpha"))
    expect(listing.parent).toBe(root)
  })

  it("reports parent=null at the filesystem root", () => {
    const listing = listDirectories("/")
    expect(listing.parent).toBe(null)
    expect(listing.path).toBe("/")
  })
})
