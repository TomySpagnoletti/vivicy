/**
 * Orphan-proof launcher for the Next standalone server sidecar.
 *
 * Tauri kills the sidecar on the normal quit paths (window close → killed by the
 * Rust `Sidecar` handlers). But if the desktop app is terminated ABNORMALLY (a
 * raw SIGKILL/SIGTERM to the app process, a crash), the Rust teardown never runs
 * and the Node child would be left orphaned, holding its localhost port. This
 * launcher closes that gap: it runs the Next server in-process and continuously
 * checks whether it has been orphaned (reparented away from the launching app),
 * exiting the whole process the moment it has — so the server can never outlive
 * the app it belongs to.
 *
 * Usage (from the Rust sidecar): `node launch-server.mjs <abs path to server.js>`.
 * PORT / HOSTNAME / NODE_ENV are passed through the environment by Tauri exactly
 * as the Next standalone server expects.
 */

import path from "node:path"
import { pathToFileURL } from "node:url"

const serverEntry = process.argv[2]
if (!serverEntry) {
  console.error("[vivicy-launcher] missing server entry path argument")
  process.exit(1)
}

// The Next standalone server resolves `.next` and static assets relative to the
// current working directory, so run from the server's own directory.
process.chdir(path.dirname(serverEntry))

// The PID of the parent (the Tauri app) at launch. If our parent changes — on
// Unix an orphaned child is reparented to init (pid 1) or launchd — the app is
// gone and we must exit. Windows has no reparenting, but Tauri's job-object kill
// covers the abnormal case there, and the normal Rust teardown covers both.
const originalParent = process.ppid

const POLL_MS = 1000
const orphanWatch = setInterval(() => {
  const current = process.ppid
  // Reparented (parent died) → orphaned. Exit so the port is released and no
  // server outlives the app.
  if (current !== originalParent || current <= 1) {
    console.error("[vivicy-launcher] parent app gone — shutting the server down")
    process.exit(0)
  }
}, POLL_MS)
// Don't let this timer keep the process alive on its own.
orphanWatch.unref()

// Boot the Next standalone server in THIS process, so exiting the process (here,
// or via the orphan watch) stops the server. The standalone server.js binds on
// import using PORT/HOSTNAME from the environment.
await import(pathToFileURL(serverEntry).href).catch((error) => {
  console.error("[vivicy-launcher] failed to start the Next server:", error)
  process.exit(1)
})
