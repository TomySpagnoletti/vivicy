#!/usr/bin/env node
// Vivicy CLI — point the autonomous dev factory at any target project.
//
// Vivicy operates ON a target project: it reads that project's canonical docs,
// architecture map, issue index, and progress ledger, and drives the two-agent
// implement -> review -> verify loop over them. The target is selected with
// VIVICY_TARGET_ROOT (or `--target <dir>`); everything else is local to this
// package.
//
// Usage:
//   vivicy app        [--target <dir>] [--port <n>]   start the visual control plane (Next.js)
//   vivicy loop       [--target <dir>]                run the deterministic two-agent dev loop
//   vivicy supervise  [--target <dir>]                run the resumable supervisor around the loop
//   vivicy status     [--target <dir>] [--json]       read-only health probe for a run
//   vivicy rehearsal  [--dry]                         end-to-end method rehearsal (isolated fixture)
//   vivicy --help
//
// `--target <dir>` is shorthand for setting VIVICY_TARGET_ROOT for the child.
// When omitted, the factory falls back to VIVICY_TARGET_ROOT, then the legacy
// NAIGHT_DEV_ROOT, then the project this package is vendored into.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const factoryDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(factoryDir, ".."); // the Vivicy app (package root)

const HELP = `Vivicy — a visual autonomous dev factory.

Usage:
  vivicy app        [--target <dir>] [--port <n>]   start the visual control plane
  vivicy loop       [--target <dir>]                run the two-agent dev loop once
  vivicy supervise  [--target <dir>]                run the resumable supervisor
  vivicy status     [--target <dir>] [--json]       read-only run health probe
  vivicy rehearsal  [--dry]                         end-to-end method rehearsal
  vivicy --help

The target project is chosen with --target or VIVICY_TARGET_ROOT.
`;

function takeFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  argv.splice(i, value !== undefined && !value.startsWith("--") ? 2 : 1);
  return value ?? null;
}

function run(command, args, { cwd, env } = {}) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const command = argv.shift();
  const target = takeFlag(argv, "--target");
  const env = target ? { VIVICY_TARGET_ROOT: resolve(target) } : {};

  switch (command) {
    case "app": {
      const port = takeFlag(argv, "--port");
      const args = ["next", "dev", ...(port ? ["--port", port] : []), ...argv];
      run("npx", args, { cwd: appDir, env });
      return;
    }
    case "loop":
      run(process.execPath, [resolve(factoryDir, "dev-loop.mjs"), ...argv], { env });
      return;
    case "supervise":
      run(process.execPath, [resolve(factoryDir, "dev-loop-supervised.mjs"), ...argv], { env });
      return;
    case "status":
      run(process.execPath, [resolve(factoryDir, "dev-status.mjs"), ...argv], { env });
      return;
    case "rehearsal":
      run(process.execPath, [resolve(factoryDir, "dev-rehearsal.mjs"), ...argv], { env });
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exit(1);
  }
}

main();
