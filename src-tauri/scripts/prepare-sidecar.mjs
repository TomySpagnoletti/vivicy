#!/usr/bin/env node
/**
 * Prepare the Tauri sidecar before `tauri dev` / `tauri build`.
 *
 * Vivicy's UI needs a live Node/Next server (its API routes spawn agent CLIs,
 * browse the FS, stream status), so the desktop app can't ship a static export.
 * Instead it runs the Next **standalone** server as a Tauri sidecar. This script
 * assembles everything that sidecar needs:
 *
 *   1. Build Next in standalone mode (`VIVICY_DESKTOP=1 next build`) →
 *      `.next/standalone/server.js` + a trimmed `node_modules`.
 *   2. Stage that standalone server (plus `.next/static` and `public/`, which the
 *      standalone output does NOT copy) into `src-tauri/server/`. Tauri bundles
 *      this directory as an app resource; the Rust shell runs
 *      `node <resource>/server/server.js`.
 *   3. Copy the running Node binary to `src-tauri/binaries/node-<target-triple>`
 *      — Tauri's `externalBin` naming convention — so a Node runtime ships with
 *      the app and no system Node is required on the user's machine.
 *   4. Write a tiny placeholder `frontendDist` so Tauri's build is satisfied; the
 *      window never shows it (it navigates to the sidecar URL at runtime).
 *
 * Idempotent: safe to re-run; it cleans its own outputs first. It only ever
 * touches `src-tauri/server`, `src-tauri/binaries`, and `src-tauri/placeholder`.
 */

import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SRC_TAURI = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const APP_ROOT = path.dirname(SRC_TAURI)

const SERVER_OUT = path.join(SRC_TAURI, "server")
const BIN_OUT = path.join(SRC_TAURI, "binaries")
const PLACEHOLDER = path.join(SRC_TAURI, "placeholder")
const STANDALONE = path.join(APP_ROOT, ".next", "standalone")

// The Node runtime version bundled as the sidecar. We ship an OFFICIAL,
// self-contained Node distribution (not the build machine's Node, which on
// Homebrew/Linux is dynamically linked against libnode + system dylibs and is
// therefore NOT portable). Official builds are relocatable and run the Next
// standalone server with no system Node required on the user's machine.
const SIDECAR_NODE_VERSION = process.env.VIVICY_SIDECAR_NODE_VERSION ?? "22.14.0"

/** Run a command, inheriting stdio so build output streams to the user. */
function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: APP_ROOT, ...opts })
}

/** Resolve the Rust host target triple (e.g. aarch64-apple-darwin). */
function hostTargetTriple() {
  // Honor an explicit override (CI cross-builds pass --target; the workflow sets
  // this so the staged binary name matches the requested triple).
  if (process.env.VIVICY_TARGET_TRIPLE) return process.env.VIVICY_TARGET_TRIPLE.trim()
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  const match = out.match(/host:\s*(\S+)/)
  if (!match) throw new Error("could not determine the Rust host target triple from `rustc -vV`")
  return match[1]
}

/** The sidecar binary file extension for the current platform. */
function exeSuffix(triple) {
  return triple.includes("windows") ? ".exe" : ""
}

function clean() {
  for (const dir of [SERVER_OUT, BIN_OUT, PLACEHOLDER]) {
    rmSync(dir, { recursive: true, force: true })
  }
}

function buildNext() {
  console.log("[prepare-sidecar] building Next in standalone mode…")
  run("npx", ["next", "build"], { env: { ...process.env, VIVICY_DESKTOP: "1" } })
  // The standalone output must contain BOTH the server entry and the trimmed
  // node_modules. If either is missing the build silently produced non-standalone
  // output (e.g. VIVICY_DESKTOP wasn't honored) — fail loudly rather than ship a
  // sidecar that cannot run.
  for (const required of ["server.js", "node_modules"]) {
    if (!existsSync(path.join(STANDALONE, required))) {
      throw new Error(
        `expected ${path.join(STANDALONE, required)} after build — is output:"standalone" active (VIVICY_DESKTOP=1)?`
      )
    }
  }
}

function stageServer() {
  console.log("[prepare-sidecar] staging the standalone server → src-tauri/server")
  mkdirSync(SERVER_OUT, { recursive: true })
  // The whole standalone tree (server.js + trimmed node_modules + .next runtime).
  cpSync(STANDALONE, SERVER_OUT, { recursive: true })
  // Next's standalone output deliberately omits static assets and public/ — copy
  // them into the SAME relative layout the standalone server expects.
  const staticSrc = path.join(APP_ROOT, ".next", "static")
  if (existsSync(staticSrc)) {
    cpSync(staticSrc, path.join(SERVER_OUT, ".next", "static"), { recursive: true })
  }
  const publicSrc = path.join(APP_ROOT, "public")
  if (existsSync(publicSrc)) {
    cpSync(publicSrc, path.join(SERVER_OUT, "public"), { recursive: true })
  }
  // The orphan-proof launcher that boots server.js and self-terminates if the
  // desktop app dies abnormally (so no sidecar is ever left holding its port).
  cpSync(
    path.join(SRC_TAURI, "sidecar", "launch-server.mjs"),
    path.join(SERVER_OUT, "launch-server.mjs")
  )
}

/**
 * Map a Rust target triple to the official Node.js distribution descriptor for
 * the SAME OS/arch: the dist platform/arch tokens, the archive kind, and the
 * binary path inside the archive.
 */
function nodeDistFor(triple) {
  const t = triple.toLowerCase()
  const arch = t.startsWith("aarch64") || t.startsWith("arm64") ? "arm64" : "x64"
  if (t.includes("apple-darwin")) {
    return { os: "darwin", arch, kind: "tar.gz", inner: "bin/node" }
  }
  if (t.includes("windows")) {
    return { os: "win", arch, kind: "zip", inner: "node.exe" }
  }
  if (t.includes("linux")) {
    return { os: "linux", arch, kind: "tar.xz", inner: "bin/node" }
  }
  throw new Error(`unsupported target triple for the Node sidecar: ${triple}`)
}

/**
 * Stage the Node sidecar binary, named `node-<triple>(.exe)` per Tauri's
 * externalBin convention. Downloads + extracts the official self-contained Node
 * distribution for the target OS/arch (cached in the temp dir between runs) and
 * copies out just the relocatable `node` binary.
 */
function stageNode(triple) {
  mkdirSync(BIN_OUT, { recursive: true })
  const ext = exeSuffix(triple)
  const dest = path.join(BIN_OUT, `node-${triple}${ext}`)
  const dist = nodeDistFor(triple)
  const v = SIDECAR_NODE_VERSION
  const stem = `node-v${v}-${dist.os}-${dist.arch}`
  const archive = `${stem}.${dist.kind}`
  const url = `https://nodejs.org/dist/v${v}/${archive}`

  console.log(`[prepare-sidecar] staging Node ${v} sidecar (${dist.os}-${dist.arch}) → ${path.basename(dest)}`)

  const cacheDir = path.join(tmpdir(), "vivicy-node-sidecar")
  mkdirSync(cacheDir, { recursive: true })
  const archivePath = path.join(cacheDir, archive)
  if (!existsSync(archivePath)) {
    console.log(`[prepare-sidecar]   downloading ${url}`)
    // `curl` is used directly (not fetch) so the build machine's TLS/proxy
    // behaves identically to other downloads in this environment.
    run("curl", ["-fSL", "--retry", "3", "-o", archivePath, url], { cwd: cacheDir })
  }

  // Extract just the one binary member (`<stem>/<inner>`) out of the archive.
  // Both `unzip` and `tar` can target a single path, so we never unpack the whole
  // ~30-80MB tree. The Windows distribution carries node.exe at the archive root
  // (`<stem>/node.exe`); the *nix tarballs carry it at `<stem>/bin/node`.
  const member = `${stem}/${dist.inner}`
  rmSync(path.join(cacheDir, stem), { recursive: true, force: true })
  if (dist.kind === "zip") {
    run("unzip", ["-q", "-o", archivePath, member, "-d", cacheDir])
  } else {
    // tar auto-detects gz/xz and extracts the single member into cacheDir.
    run("tar", ["-xf", archivePath, "-C", cacheDir, member])
  }
  cpSync(path.join(cacheDir, member), dest)
  // Make the *nix sidecar executable; on Windows the .exe needs no exec bit.
  if (!triple.includes("windows")) chmodSync(dest, 0o755)
}

function stagePlaceholder() {
  // Tauri requires `frontendDist` to point at an existing dir with an index. The
  // window navigates to the sidecar URL at runtime, so this is never shown; it
  // only satisfies the build and is a visible fallback if the sidecar fails.
  mkdirSync(PLACEHOLDER, { recursive: true })
  writeFileSync(
    path.join(PLACEHOLDER, "index.html"),
    "<!doctype html><meta charset=utf-8><title>Vivicy</title><body>Starting Vivicy…</body>"
  )
}

function main() {
  const triple = hostTargetTriple()
  clean()
  buildNext()
  stageServer()
  stageNode(triple)
  stagePlaceholder()
  console.log(`[prepare-sidecar] done (target ${triple}).`)
}

main()
