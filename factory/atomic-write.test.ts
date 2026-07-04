import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { atomicWriteJson } from "./atomic-write.ts";

// atomicWriteJson(absolutePath, value): writes `value` as pretty-printed JSON to a
// sibling temp file, then rename(2)s it into place atomically. The contract under
// test: the destination ends up with exactly the serialized value, missing parent
// dirs are created, a re-write overwrites, and no `.tmp` sibling is left behind.

function scratch() {
  const root = mkdtempSync(resolve(tmpdir(), "atomic-write-test-"));
  return {
    root,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
}

test("writes the file with exactly the serialized JSON (pretty-printed, trailing newline)", () => {
  const s = scratch();
  try {
    const target = resolve(s.root, "out.json");
    const value = { b: 2, a: 1, nested: { z: [3, 2, 1] } };
    atomicWriteJson(target, value);

    assert.ok(existsSync(target), "destination file exists");
    const onDisk = readFileSync(target, "utf8");
    // Byte-for-byte: 2-space indent + a single trailing newline, no key reordering.
    assert.equal(onDisk, `${JSON.stringify(value, null, 2)}\n`);
    // And it round-trips back to the same value.
    assert.deepEqual(JSON.parse(onDisk), value);
  } finally {
    s.cleanup();
  }
});

test("throws when the parent directory is missing (it does not create parent dirs) and leaves no residue", () => {
  const s = scratch();
  try {
    // The writer opens a sibling temp file next to the destination and renames it;
    // it never mkdir's. So a destination under a non-existent directory must throw
    // (ENOENT on the temp open), and nothing may be written into the scratch root.
    const target = resolve(s.root, "missing-dir", "out.json");
    assert.ok(!existsSync(resolve(s.root, "missing-dir")), "parent dir does not exist");

    assert.throws(() => atomicWriteJson(target, { ok: true }), { code: "ENOENT" });

    assert.ok(!existsSync(target), "no file created under the missing directory");
    assert.deepEqual(readdirSync(s.root), [], "scratch root stays empty after the failed write");
  } finally {
    s.cleanup();
  }
});

test("writes cleanly when the parent directory already exists", () => {
  const s = scratch();
  try {
    const nested = mkdtempSync(resolve(s.root, "nested-"));
    const target = resolve(nested, "out.json");

    atomicWriteJson(target, { ok: true });

    assert.ok(existsSync(target), "file created inside the existing directory");
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { ok: true });
    const stray = readdirSync(nested).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(stray, [], `unexpected stray temp files: ${stray.join(", ")}`);
  } finally {
    s.cleanup();
  }
});

test("a second write overwrites the prior contents in place", () => {
  const s = scratch();
  try {
    const target = resolve(s.root, "out.json");
    atomicWriteJson(target, { revision: 1, payload: "first" });
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { revision: 1, payload: "first" });

    atomicWriteJson(target, { revision: 2 });
    const onDisk = JSON.parse(readFileSync(target, "utf8")) as { revision: number; payload?: string };
    assert.deepEqual(onDisk, { revision: 2 }, "second write fully replaces the first");
    assert.equal(onDisk.payload, undefined, "no stale key bled through from the first write");
  } finally {
    s.cleanup();
  }
});

test("leaves no temp file behind after a successful write", () => {
  const s = scratch();
  try {
    const target = resolve(s.root, "out.json");
    atomicWriteJson(target, { ok: true });

    const stray = readdirSync(s.root).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(stray, [], `unexpected stray temp files: ${stray.join(", ")}`);
    assert.deepEqual(readdirSync(s.root), ["out.json"], "only the destination remains");
  } finally {
    s.cleanup();
  }
});

test("repeated writes do not accumulate temp siblings across the directory", () => {
  const s = scratch();
  try {
    const target = resolve(s.root, "out.json");
    for (let i = 0; i < 5; i += 1) {
      atomicWriteJson(target, { revision: i });
    }
    assert.equal(JSON.parse(readFileSync(target, "utf8")).revision, 4);
    assert.deepEqual(readdirSync(s.root), ["out.json"], "no temp residue after many writes");
  } finally {
    s.cleanup();
  }
});

test("propagates the error when the destination directory is unwritable (rename fails) and cleans up its temp file", () => {
  const s = scratch();
  try {
    // A path whose parent is an existing FILE, not a directory: mkdirSync is not
    // called by atomicWriteJson (it does not create parents), so opening the temp
    // sibling under a file-as-directory must throw, and no `.tmp` may linger.
    const fileAsParent = resolve(s.root, "a-file");
    atomicWriteJson(fileAsParent, { ok: true });
    assert.ok(existsSync(fileAsParent), "the blocking file exists");

    const impossible = resolve(fileAsParent, "child.json");
    assert.throws(() => atomicWriteJson(impossible, { ok: true }));

    // The directory still contains only the destination + the blocking file —
    // no half-written temp sibling escaped.
    const stray = readdirSync(s.root).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(stray, [], `unexpected stray temp files after failure: ${stray.join(", ")}`);
  } finally {
    s.cleanup();
  }
});
