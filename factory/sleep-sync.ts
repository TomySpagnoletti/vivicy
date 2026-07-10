// Atomics.wait on a private SharedArrayBuffer parks the thread without spinning the CPU; the buffer is never written, so it always times out after the requested slice by design.
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const end = Date.now() + ms;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < end) {
    Atomics.wait(sab, 0, 0, Math.min(1000, end - Date.now()));
  }
}
