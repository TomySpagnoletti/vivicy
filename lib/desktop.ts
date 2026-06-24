/**
 * Desktop (Tauri) feature bridge. Vivicy ships both as a plain web app (Next
 * server in a browser) and as a Tauri desktop shell that wraps that same server
 * as a localhost sidecar. The two share one codebase; the *only* difference is
 * that a handful of affordances upgrade to native OS integration when they detect
 * the Tauri runtime.
 *
 * This module is the single seam for that feature-detection. Everything here is
 * client-safe and degrades cleanly: when `window.__TAURI__` is absent (the
 * browser build, SSR, or tests) `isDesktop()` returns false and the native helpers
 * throw a typed {@link DesktopUnavailableError} so callers fall back to the web
 * path rather than crash.
 *
 * The Tauri plugin JS APIs are imported lazily *inside* the helpers, so the web
 * bundle never eagerly loads `@tauri-apps/*` and SSR never touches `window`.
 */

import { useSyncExternalStore } from "react"

/** Thrown when a native helper is called outside the Tauri desktop shell. */
export class DesktopUnavailableError extends Error {
  constructor(message = "Native desktop APIs are unavailable in the web build") {
    super(message)
    this.name = "DesktopUnavailableError"
  }
}

/**
 * True only inside the Tauri desktop shell. Tauri injects `window.__TAURI__` (and
 * `window.__TAURI_INTERNALS__`) into the webview; neither exists in a normal
 * browser. Guarded for SSR (`typeof window`), so it is safe to call during render.
 */
export function isDesktop(): boolean {
  return (
    typeof window !== "undefined" &&
    // `__TAURI_INTERNALS__` is the v2 marker; `__TAURI__` is present when
    // `app.withGlobalTauri` is enabled. Either proves the desktop shell.
    (Reflect.has(window, "__TAURI_INTERNALS__") || Reflect.has(window, "__TAURI__"))
  )
}

/**
 * React-idiomatic, hydration-safe read of {@link isDesktop} for components. Uses
 * `useSyncExternalStore` so it returns the SSR/server snapshot (false) on the
 * first client render — matching the server HTML to avoid a hydration mismatch —
 * then the real client value, all WITHOUT a setState-in-effect. The Tauri global
 * never changes after load, so the subscribe callback is a no-op.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    // No external changes to subscribe to: the desktop runtime is fixed at load.
    () => () => {},
    // Client snapshot: the real detection.
    () => isDesktop(),
    // Server snapshot: always the web fallback.
    () => false
  )
}

/**
 * Open the OS-native directory chooser and return the absolute path the user
 * picked, or null when they cancelled. Desktop-only — callers must gate on
 * {@link isDesktop} and keep the in-app web browser as the fallback.
 */
export async function pickDirectoryNative(): Promise<string | null> {
  if (!isDesktop()) throw new DesktopUnavailableError()
  const { open } = await import("@tauri-apps/plugin-dialog")
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose the project Vivicy should develop",
  })
  // The dialog returns a string (single dir), an array (multiple), or null. We
  // request a single directory, so normalize to string | null.
  if (selected == null) return null
  return Array.isArray(selected) ? (selected[0] ?? null) : selected
}

/** One streamed line of output from a native command run. */
export interface CommandLine {
  /** "stdout" | "stderr" — which stream the line came from. */
  stream: "stdout" | "stderr"
  /** The line text (no trailing newline). */
  line: string
}

/** Terminal result of a native command run. */
export interface CommandResult {
  /** The process exit code (null if it was killed by a signal). */
  code: number | null
  /** True when the process exited 0. */
  ok: boolean
}

/**
 * Run one of the *allow-listed* install/version commands natively via the Tauri
 * shell plugin, streaming each output line through `onLine`, and resolve with the
 * terminal result. The command name must match a sidecar permission declared in
 * the shell plugin's capability allow-list (see `src-tauri/capabilities`); the
 * shell plugin rejects anything else, so this can never open an arbitrary shell.
 *
 * Desktop-only. Callers gate on {@link isDesktop} and keep the copyable command
 * as the web fallback.
 */
export async function runAllowedCommandNative(
  /** The allow-list key (e.g. "install-claude"), NOT a raw shell string. */
  name: string,
  onLine: (line: CommandLine) => void
): Promise<CommandResult> {
  if (!isDesktop()) throw new DesktopUnavailableError()
  const { Command } = await import("@tauri-apps/plugin-shell")
  // `Command.create` looks the name up in the allow-list; args are fixed there.
  const command = Command.create(name)
  command.stdout.on("data", (line: string) => onLine({ stream: "stdout", line }))
  command.stderr.on("data", (line: string) => onLine({ stream: "stderr", line }))

  return await new Promise<CommandResult>((resolve, reject) => {
    command.on("close", (data: { code: number | null }) => {
      resolve({ code: data.code, ok: data.code === 0 })
    })
    command.on("error", (error: string) => reject(new Error(error)))
    // Spawn after handlers are attached so no early line is missed.
    command.spawn().catch(reject)
  })
}
