/**
 * @fileoverview Best-of-N timing for performance budgets in the test suites.
 *
 * A wall-clock budget asserted on a SINGLE run (or on the slowest of several)
 * measures the machine, not the code: on a shared dev box with a load average
 * in the twenties, a 1.5s smoke test measures 6s and a 0.1ms regex check
 * measures 12ms, and the suite goes red with nothing changed. Contention only
 * ever ADDS time, so the fastest of several runs is the closest estimate of a
 * routine's true cost. Asserting on that keeps a real regression -- an
 * accidental network call, an O(n^2) scan, catastrophic backtracking -- failing
 * (it slows EVERY run, the fastest included) while a busy machine does not.
 *
 * The budgets themselves are not moved. That is the point: "a budget that
 * moves to fit the measurement is not a budget" (see the M4 SLA test). What
 * changes is which statistic is held to it.
 */
"use strict";

const { performance } = require("perf_hooks");

/**
 * Run `fn` `iterations` times and return the fastest wall-clock duration in
 * milliseconds. `fn` may return a value; the value from the LAST run is
 * exposed on the result so callers can still assert on it.
 * @template T
 * @param {() => T} fn
 * @param {number} [iterations=5]
 * @return {{ fastestMs: number, slowestMs: number, allMs: number[], result: T }}
 */
function fastest(fn, iterations = 5) {
  const allMs = [];
  let result;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    result = fn();
    allMs.push(performance.now() - t0);
  }
  return {
    fastestMs: Math.min(...allMs),
    slowestMs: Math.max(...allMs),
    allMs,
    result
  };
}

module.exports = { fastest };
