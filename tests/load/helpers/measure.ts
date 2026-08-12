/**
 * Measurement primitives for the load suite.
 *
 * WALL-CLOCK IS THE WEAKEST INSTRUMENT and is used here only where nothing
 * better exists. In order of preference:
 *
 *   1. countStatements() — how many SQL statements a call prepares. Discrete,
 *      deterministic, identical on every machine. This is what an N+1 actually
 *      IS, so it is the right thing to assert on.
 *   2. countCalls()      — how many times a hot function ran. Same argument.
 *   3. growthRatio()     — t(4n)/t(n) in ONE process after a warm-up. A ratio
 *      cancels machine speed, so "someone reintroduced a nested loop" is
 *      catchable without pinning a millisecond number to a shared runner.
 *
 * Absolute milliseconds are reported, never asserted — except as a generous
 * hang sentinel, whose purpose is to catch "this never finishes", not to
 * police a regression.
 */

import fs from "node:fs";
import path from "node:path";

/** A reported measurement. Printed by the test, never asserted on directly. */
const MIN_MEASURABLE_MS = 25;

/** A reported measurement. */
export interface Timing {
  label: string;
  ms: number;
  n: number;
  perItemUs: number;
}

export function time(label: string, n: number, fn: () => void): Timing {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  return { label, ms, n, perItemUs: n > 0 ? (ms * 1000) / n : 0 };
}

/**
 * Results go to a JSON artifact, not just stdout.
 *
 * Load numbers are a trend to read over time, not a pass/fail line — and
 * stdout from a test runner is the worst possible place to keep a trend. The
 * file is gitignored; point a chart at it or diff two runs.
 */
const ARTIFACT = path.join(process.cwd(), "load-results.json");

export function report(t: Timing, extra: Record<string, unknown> = {}): void {
  const line = `${t.label.padEnd(46)} n=${String(t.n).padStart(8)}  ${t.ms.toFixed(0).padStart(7)} ms  ${t.perItemUs.toFixed(2).padStart(9)} µs/item`;
  console.log("    " + line);
  let all: unknown[] = [];
  try {
    all = JSON.parse(fs.readFileSync(ARTIFACT, "utf8")) as unknown[];
  } catch {
    all = [];
  }
  all.push({ ...t, ...extra });
  fs.writeFileSync(ARTIFACT, JSON.stringify(all, null, 2) + "\n");
}

/** Wipe the artifact so a run reflects only itself. Call once per file. */
export function resetArtifact(): void {
  try {
    fs.rmSync(ARTIFACT, { force: true });
  } catch {
    /* first run */
  }
}

/**
 * Run `fn` at n and at 4n and return the time ratio.
 *
 * Linear work → ~4. Quadratic → ~16. The threshold callers use is 6, which is
 * comfortably above linear-with-overhead and far below quadratic.
 *
 * The warm-up matters: without it the first call pays JIT and allocation costs
 * that make a linear function look superlinear.
 */
export function growthRatio(
  makeInput: (size: number) => unknown,
  run: (input: never) => void,
  n: number,
): { ratio: number; small: Timing; large: Timing } {
  const warm = makeInput(n);
  run(warm as never);
  run(warm as never);

  const smallInput = makeInput(n);
  const small = time(`n=${n}`, n, () => run(smallInput as never));

  const largeInput = makeInput(n * 4);
  const large = time(`n=${n * 4}`, n * 4, () => run(largeInput as never));

  /**
   * A ratio built on an unmeasurably fast baseline is noise wearing a number.
   * At a 3 ms baseline, ±2 ms of scheduler jitter alone swings the ratio
   * between 2× and 10× — which is exactly what happened once a quadratic was
   * fixed here: the operation got 35× faster and the ratio test started
   * failing on measurement error rather than on complexity. Throw instead of
   * returning a number nobody should trust, and say what to do about it.
   */
  if (small.ms < MIN_MEASURABLE_MS) {
    throw new Error(
      `Baseline n=${n} ran in ${small.ms.toFixed(1)} ms, below the ${MIN_MEASURABLE_MS} ms floor — ` +
        "the ratio would be timer noise. Raise n until the baseline clears the floor.",
    );
  }
  return { ratio: large.ms / small.ms, small, large };
}

/**
 * Count the SQL statements prepared while `fn` runs.
 *
 * Drizzle prepares one statement per query, so this counts queries — including
 * the ones issued inside a loop, which is the whole point. Patches the
 * prototype rather than the instance because Drizzle holds its own reference.
 */
export function countStatements<T>(sqlite: { constructor: unknown }, fn: () => T): { result: T; statements: number } {
  const proto = (sqlite as { constructor: { prototype: Record<string, unknown> } }).constructor.prototype;
  const original = proto.prepare as (...args: unknown[]) => unknown;
  let statements = 0;
  proto.prepare = function patched(this: unknown, ...args: unknown[]) {
    statements++;
    return original.apply(this, args);
  };
  try {
    return { result: fn(), statements };
  } finally {
    proto.prepare = original;
  }
}

/** Count calls to one method of an object, restoring it afterwards. */
export function countCalls<T extends object, K extends keyof T>(
  obj: T,
  key: K,
  fn: () => void,
): number {
  const original = obj[key] as unknown as (...a: unknown[]) => unknown;
  let calls = 0;
  (obj[key] as unknown) = function patched(this: unknown, ...args: unknown[]) {
    calls++;
    return original.apply(this, args);
  };
  try {
    fn();
  } finally {
    (obj[key] as unknown) = original;
  }
  return calls;
}

/** Peak-ish RSS around a call, in MB. Report-only — GC timing makes it noisy. */
export function rssAround(fn: () => void): { deltaMb: number; peakMb: number } {
  global.gc?.();
  const before = process.memoryUsage().rss;
  let peak = before;
  const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  try {
    fn();
  } finally {
    clearInterval(iv);
  }
  const after = process.memoryUsage().rss;
  peak = Math.max(peak, after);
  return { deltaMb: (after - before) / 1e6, peakMb: (peak - before) / 1e6 };
}

/**
 * Deterministic PRNG (mulberry32). Seeded so a failing load run is
 * reproducible — `Math.random()` would make a threshold failure unrepeatable
 * and therefore unfixable.
 */
export function rng(seed = 0x5eed): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
