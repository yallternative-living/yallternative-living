/**
 * @fileoverview Preload that pins the wall clock for a child process:
 *
 *   YL_FREEZE_NOW=2026-10-18T16:00:00Z node -r ./scripts/lib/freeze-clock.js <script>
 *
 * `new Date()` and `Date.now()` answer that instant; `new Date(x)` and every
 * other Date API are untouched. Used by scripts/main.test.js to run the real
 * build on a known "today", so a check that depends on which events are
 * still upcoming gives the same answer on every day it runs.
 *
 * Refuses to load without a parseable instant rather than leaving the real
 * clock in place: a pin that silently did nothing is exactly the check that
 * stops checking.
 */

const FROZEN = Date.parse(process.env.YL_FREEZE_NOW || "");
if (!Number.isFinite(FROZEN)) {
  throw new Error(`freeze-clock: YL_FREEZE_NOW is not a date: ${process.env.YL_FREEZE_NOW}`);
}

const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(FROZEN);
  }
  static now() {
    return FROZEN;
  }
}
global.Date = FrozenDate;
