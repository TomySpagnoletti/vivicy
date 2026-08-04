import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import path from "node:path"

import { nodeSpawner } from "@/lib/node-spawner"
import { serverLogPath, systemClock } from "@/lib/project-registry"
import { ProjectServerError, type ServerHost } from "@/lib/project-server"
import type { ProjectBinding } from "@/lib/project-types"

const PROBE_TIMEOUT_MS = 2_000
const LOG_TAIL_BYTES = 4_096
const LOG_TAIL_LINES = 3

function appRoot(): string {
  return process.cwd()
}

function distDir(): string {
  const override = process.env.VIVICY_DIST_DIR
  return path.resolve(appRoot(), override && override.trim().length > 0 ? override : ".next")
}

function nextBin(): string {
  return createRequire(path.join(appRoot(), "package.json")).resolve("next/dist/bin/next")
}

function logTailOf(file: string): string {
  let fd: number | null = null
  try {
    const { size } = statSync(file)
    const start = Math.max(0, size - LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    fd = openSync(file, "r")
    readSync(fd, buffer, 0, buffer.length, start)
    return buffer
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-LOG_TAIL_LINES)
      .join(" / ")
  } catch {
    return ""
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export const nodeServerHost: ServerHost = {
  ...systemClock,

  spawn({ root, port, logFile }) {
    if (!existsSync(path.join(distDir(), "BUILD_ID"))) {
      throw new ProjectServerError("Vivicy has no production build yet — run `npm run build`, then open the project again.", "not_built")
    }
    mkdirSync(path.dirname(logFile), { recursive: true })
    rmSync(logFile, { force: true })
    const env: NodeJS.ProcessEnv = { ...process.env, VIVICY_TARGET_ROOT: root }
    // The launcher governs no project, so any runtime-dir override it carries is stale config that would collapse every server onto one per-project home.
    delete env.VIVICY_RUNTIME_DIR
    delete env.PORT
    try {
      return nodeSpawner.spawnDetached({
        command: process.execPath,
        args: [nextBin(), "start", "--port", String(port), "--hostname", "127.0.0.1"],
        cwd: appRoot(),
        env,
        logFile,
      }).pid
    } catch (error) {
      throw new ProjectServerError(
        `failed to spawn the server for ${root}: ${error instanceof Error ? error.message : String(error)}`,
        "spawn_failed"
      )
    }
  },

  isAlive: (pid) => nodeSpawner.isAlive(pid),

  stop(pid, signal) {
    nodeSpawner.killGroup(pid, signal)
  },

  portFree(port) {
    return new Promise((resolve) => {
      const probe = createServer()
      probe.once("error", () => resolve(false))
      probe.once("listening", () => probe.close(() => resolve(true)))
      probe.listen({ port, host: "127.0.0.1", exclusive: true })
    })
  },

  // Readiness is the bound project answering, never a socket accepting: a foreign process on the port must read as not-ready.
  async ready(port, root) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/project`, {
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (!response.ok) return false
      const body = (await response.json()) as { binding?: ProjectBinding }
      return body.binding?.kind === "bound" && body.binding.project.root === root
    } catch {
      return false
    }
  },

  logTail: (port) => logTailOf(serverLogPath(port)),
}
