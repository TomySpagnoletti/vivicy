import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { existsSync, statSync } from "node:fs"

import {
  browseParent,
  createDirectory,
  FsBrowseError,
  listDirectories,
  pathCrumbs,
  resolveBrowsePath,
  validateFolderName,
} from "@/lib/fs-browser"

let root: string

beforeEach(() => {
  // realpathSync: macOS /tmp is a symlink to /private/tmp, and the browser canonicalizes paths — compare against the resolved real path.
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
    const resolved = resolveBrowsePath("")
    expect(path.isAbsolute(resolved)).toBe(true)
  })
})

describe("listDirectories", () => {
  it("lists only subdirectories, sorted, omitting files and dotfiles", () => {
    const listing = listDirectories(root)
    expect(listing.path).toBe(root)
    expect(listing.entries.map((e) => e.name)).toEqual(["alpha", "beta"])
    expect(listing.entries.some((e) => e.name === "a-file.txt")).toBe(false)
    expect(listing.entries.some((e) => e.name === ".hidden")).toBe(false)
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

  it("returns breadcrumb segments from the filesystem root down to the listed dir", () => {
    const listing = listDirectories(path.join(root, "alpha"))
    expect(listing.crumbs[0]).toEqual({ label: "/", path: "/" })
    expect(listing.crumbs.at(-1)).toEqual({ label: "alpha", path: path.join(root, "alpha") })
  })
})

describe("pathCrumbs (platform-correct segments, no client-side split)", () => {
  it("builds POSIX crumbs from the root down", () => {
    expect(pathCrumbs("/Users/tomy", path.posix)).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "tomy", path: "/Users/tomy" },
    ])
  })

  it("returns a single crumb at the POSIX root", () => {
    expect(pathCrumbs("/", path.posix)).toEqual([{ label: "/", path: "/" }])
  })

  it("builds Windows crumbs from the drive root with backslash separators", () => {
    expect(pathCrumbs("C:\\Users\\tomy", path.win32)).toEqual([
      { label: "C:\\", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "tomy", path: "C:\\Users\\tomy" },
    ])
  })

  it("returns a single crumb at a Windows drive root", () => {
    expect(pathCrumbs("C:\\", path.win32)).toEqual([{ label: "C:\\", path: "C:\\" }])
  })

  it("keeps the UNC share as the root crumb", () => {
    expect(pathCrumbs("\\\\srv\\share\\proj", path.win32)).toEqual([
      { label: "\\\\srv\\share\\", path: "\\\\srv\\share\\" },
      { label: "proj", path: "\\\\srv\\share\\proj" },
    ])
  })
})

describe("browseParent (up-navigation stops at every OS root)", () => {
  it("returns the POSIX parent and null at the root", () => {
    expect(browseParent("/Users/tomy", path.posix)).toBe("/Users")
    expect(browseParent("/", path.posix)).toBe(null)
  })

  it("returns the Windows parent and null at the drive root", () => {
    expect(browseParent("C:\\Users", path.win32)).toBe("C:\\")
    expect(browseParent("C:\\", path.win32)).toBe(null)
  })

  it("returns null at a UNC share root (cannot climb above the share)", () => {
    expect(browseParent("\\\\srv\\share", path.win32)).toBe(null)
  })
})

describe("validateFolderName (name-safety)", () => {
  it("accepts a clean single-segment name", () => {
    expect(validateFolderName("my-project_1.0 v2")).toBe("my-project_1.0 v2")
  })

  it("trims surrounding whitespace", () => {
    expect(validateFolderName("  spaced  ")).toBe("spaced")
  })

  it.each([
    ["", "empty"],
    ["   ", "whitespace-only"],
    [".", "bare dot"],
    ["..", "traversal"],
    ["../escape", "traversal segment"],
    ["a/b", "path separator"],
    ["/abs", "absolute"],
    [".hidden", "leading dot"],
    ["bad*name", "shell glob"],
    ["semi;colon", "shell metachar"],
    ["new\nline", "newline"],
  ])("rejects %s (%s) with invalid_name", (input) => {
    try {
      validateFolderName(input)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(FsBrowseError)
      expect((error as FsBrowseError).code).toBe("invalid_name")
    }
  })
})

describe("createDirectory (POST /api/fs/mkdir logic)", () => {
  it("creates a direct child of the validated parent and returns its path", () => {
    const created = createDirectory(root, "gamma")
    expect(created).toBe(path.join(root, "gamma"))
    expect(existsSync(created)).toBe(true)
    expect(statSync(created).isDirectory()).toBe(true)
    expect(listDirectories(root).entries.map((e) => e.name)).toContain("gamma")
  })

  it("rejects a name that already exists with the exists code", () => {
    try {
      createDirectory(root, "alpha")
      expect.unreachable("should have thrown")
    } catch (error) {
      expect((error as FsBrowseError).code).toBe("exists")
    }
  })

  it("rejects an invalid name with invalid_name (never touches disk)", () => {
    try {
      createDirectory(root, "../escape")
      expect.unreachable("should have thrown")
    } catch (error) {
      expect((error as FsBrowseError).code).toBe("invalid_name")
    }
    expect(existsSync(path.join(path.dirname(root), "escape"))).toBe(false)
  })

  it("rejects a non-existent parent with not_found (parent path-safety)", () => {
    try {
      createDirectory(path.join(root, "nope"), "child")
      expect.unreachable("should have thrown")
    } catch (error) {
      expect((error as FsBrowseError).code).toBe("not_found")
    }
  })

  it("rejects a relative parent with not_absolute", () => {
    try {
      createDirectory("relative/parent", "child")
      expect.unreachable("should have thrown")
    } catch (error) {
      expect((error as FsBrowseError).code).toBe("not_absolute")
    }
  })

  it("canonicalizes a symlinked parent before creating (writes to the real dir)", () => {
    const link = path.join(root, "link-to-alpha")
    symlinkSync(path.join(root, "alpha"), link)
    const created = createDirectory(link, "via-symlink")
    expect(created).toBe(path.join(root, "alpha", "via-symlink"))
    expect(existsSync(path.join(root, "alpha", "via-symlink"))).toBe(true)
  })
})
