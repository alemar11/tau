export interface Clock {
  now(): number;
  after(ms: number, callback: () => void, unref?: boolean): () => void;
}
export const systemClock: Clock = {
  now: () => performance.now(),
  after: (ms, callback, unref = false) => {
    const timer = setTimeout(callback, ms);
    if (unref) timer.unref();
    return () => clearTimeout(timer);
  },
};
export function milliseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error("Timeout must be an integer between 1 and 2147483647 milliseconds");
  return value;
}
