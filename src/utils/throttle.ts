/** Returns a throttled version of `fn` that fires at most once per `ms`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function throttle<T extends (...args: any[]) => void>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let last = 0;
  return (...args: Parameters<T>) => {
    const now = performance.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}
