// Atomic JSON writer shared by the dev-loop.
//
// rename(2) is atomic only within a filesystem, so we write a sibling temp file
// first and rename it into place — a concurrent reader (the status probe, the
// Vivicy SSE) never sees a half-written file.
import { closeSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";

export function atomicWriteJson(absolutePath, value) {
  const tmpPath = `${absolutePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, absolutePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup of the temp file
    }
    throw error;
  }
}
