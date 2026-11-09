export const envNumber = (name: string): number | undefined => {
  const v = process.env[name];
  return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
};

/**
 * Abort `ac` once `limitMinutes` have passed. `hit()` says whether that's why
 * it was aborted, so the caller can tell a time limit from a cancellation.
 */
export function timeLimit(ac: AbortController, limitMinutes: number) {
  let hit = false;
  const expire = () => {
    hit = true;
    ac.abort();
  };
  const timer = limitMinutes > 0 ? setTimeout(expire, limitMinutes * 60_000) : null;
  timer?.unref();
  return { hit: () => hit, clear: () => timer && clearTimeout(timer) };
}

export function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Cancelled"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export const minutes = (n: number) => (n === 1 ? "1 minute" : `${n} minutes`);
