// rename(2) is atomic only within a filesystem; write a sibling temp file then rename so concurrent readers (status probe, SSE) never see a half-written file.
import { closeSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";

export function atomicWriteJson(absolutePath: string, value: unknown): void {
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
    }
    throw error;
  }
}
