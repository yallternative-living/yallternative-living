/**
 * @fileoverview POST /api/gift-card-balance -- what is left on this card.
 *
 * Replaces netlify/functions/gift-card-balance.js. Two things changed beyond
 * the move:
 *
 *   1. The answer comes from the GiftCardLedger Durable Object, not from a
 *      Stripe promotion code's `amount_off`. The ledger is the system of record
 *      for balances now, and it is the only place that knows about money held
 *      by an in-flight checkout (`pendingCents`) as opposed to spendable.
 *   2. It is rate-limited -- 10 lookups a minute per IP. The old endpoint had
 *      none and said so in its own header comment: Netlify Functions are
 *      stateless and the project had nowhere to count. The audit called it "an
 *      unthrottled validation oracle" over a ~1e9 code space. The space is now
 *      1.15e18 (12 symbols over 32) AND the counter exists, so guessing is
 *      slow and pointless rather than merely pointless.
 *
 * ONE ANSWER FOR EVERY MISS. "no such code", "issued but spent" and "zero
 * balance" all return the same 404 and the same sentence. Distinguishing them
 * tells a guesser which strings are real, which is precisely what enumeration
 * is looking for. A malformed code is the exception: that is a typo the shopper
 * can fix, it costs no lookup, and it reveals nothing.
 */

import { json, readJson, clientIp } from "./http.js";
import { isGiftCardCode } from "./gift-cards.js";
import { giftCardLedger, LedgerError } from "../state/gift-card-ledger.js";
import { checkRateLimit } from "../state/rate-limit.js";

export const GENERIC_NOT_FOUND = "Gift card code not found, inactive, or fully redeemed.";
const BAD_FORMAT = "Invalid code format. Format must be YALL-XXXX-XXXX-XXXX.";

export const BALANCE_RATE_LIMIT = { limit: 10, period: 60 };

export async function handleGiftCardBalance(request, env, origin) {
  if (!env.GIFT_CARD_LEDGER) {
    // Startup guard. Without the binding there is no ledger to ask, and
    // answering "not found" would tell a shopper their real card is dead.
    console.error("gift-card-balance: GIFT_CARD_LEDGER binding is missing");
    return json(
      { valid: false, error: "Gift card balances are temporarily unavailable." },
      503,
      origin,
      env
    );
  }

  const body = await readJson(request, "Please enter a gift card code.");
  const raw = body.code;

  // Format first: a malformed guess must not reach the limiter's budget, the
  // Durable Object, or the timing of a real lookup.
  if (!isGiftCardCode(raw)) {
    return json({ valid: false, error: BAD_FORMAT }, 404, origin, env);
  }

  const limit = await checkRateLimit(env, `gift-card-balance:${clientIp(request)}`, {
    ...BALANCE_RATE_LIMIT,
    failOpen: true
  });
  if (!limit.success) {
    return json(
      { valid: false, error: "Too many balance checks. Please wait a minute and try again." },
      429,
      origin,
      env
    );
  }

  let snapshot;
  try {
    snapshot = await giftCardLedger(env, raw).getBalance();
  } catch (err) {
    if (err instanceof LedgerError) {
      return json({ valid: false, error: GENERIC_NOT_FOUND }, 404, origin, env);
    }
    throw err;
  }

  if (!snapshot || !snapshot.issued || !(snapshot.balanceCents > 0)) {
    return json({ valid: false, error: GENERIC_NOT_FOUND }, 404, origin, env);
  }

  const balanceDollars = snapshot.balanceCents / 100;
  const initialCents = snapshot.initialCents || snapshot.balanceCents;
  return json(
    {
      valid: true,
      code: snapshot.code,
      balanceCents: snapshot.balanceCents,
      balance: balanceDollars,
      formattedBalance: `$${balanceDollars.toFixed(2)}`,
      // Money this card is holding for a checkout that has not been paid yet.
      // It is already out of `balanceCents`; it is reported so the drawer can
      // explain a balance that looks lower than the shopper expects.
      pendingCents: snapshot.pendingCents || 0,
      initialAmountCents: initialCents,
      initialAmount: initialCents / 100,
      currency: "usd",
      expires: null // Y'allternative Living gift cards never expire
    },
    200,
    origin,
    env
  );
}
