// Test-only setup: bind the factory's target root to a dedicated temp directory.
//
// The factory modules (progress-ledger.mjs, semantic-extraction-check.mjs,
// dev-loop.mjs) bind their target root from resolveTargetRoot() at MODULE LOAD
// TIME. ESM evaluates the full static-import graph before any top-level code in a
// test file runs, so setting process.env.VIVICY_TARGET_ROOT inside a test file's
// body is too late — a transitively-imported factory module would already have
// captured the unset (null) value.
//
// A test file imports THIS module FIRST. Because static imports evaluate in source
// order and each is fully evaluated before the next, this module's side effect —
// creating a temp dir and pointing VIVICY_TARGET_ROOT at it — runs before any
// later import that pulls in a factory module. The factory module then binds its
// repoRoot to the same temp root, making the test self-contained against a host.
//
// node --test isolates each test file in its own process by default, so each file
// gets a fresh, uniquely-named temp root and they never collide.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export const testTargetRoot = mkdtempSync(resolve(tmpdir(), "vivicy-test-target-"));
process.env.VIVICY_TARGET_ROOT = testTargetRoot;
