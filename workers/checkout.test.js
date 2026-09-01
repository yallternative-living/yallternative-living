/* eslint-env node */
/**
 * @fileoverview Unit test suite for workers/checkout.js co-located in workers/.
 * Asserts Express 1-Tap Wallets (Apple Pay, Google Pay, Stripe Link, Cash App Pay),
 * 3DS options, and metadata forwarding (discount_code, is_gift_order, gift_message, pickup_market).
 *
 * Run: node workers/checkout.test.js
 */

const { runWorkerCheckoutTests } = require("../scripts/worker-checkout.test.js");

if (require.main === module) {
  runWorkerCheckoutTests().catch((err) => {
    console.error("Worker checkout test suite error:", err);
    process.exit(1);
  });
}

module.exports = { runWorkerCheckoutTests };
