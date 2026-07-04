// Synchronous blocking wait shared by the deterministic factory scripts.
//
// Atomics.wait on a private SharedArrayBuffer parks the thread for the interval
// instead of spinning the CPU. The wait can never be satisfied (nothing ever
// writes the buffer), so it always times out after the requested slice.
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const end = Date.now() + ms;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < end) {
    Atomics.wait(sab, 0, 0, Math.min(1000, end - Date.now()));
  }
}
