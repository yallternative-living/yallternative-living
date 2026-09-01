# E2E Test Infra: Y'allternative Living E-Commerce Quick Wins Suite

## Test Philosophy
- Opaque-box, requirement-driven testing covering all 5 Quick Wins (R1-R5).
- Methodology: Category-Partition + Boundary Value Analysis + Pairwise Combinations + Real-World Workloads.
- No reliance on internal implementation details; assertions target user-visible DOM, events, JSON-LD schemas, and cart states.

## Feature Inventory
| # | Feature | Source (Requirement) | Tier 1 (Coverage) | Tier 2 (Boundary) | Tier 3 (Cross-Feature) | Tier 4 (Real-World) |
|---|---------|----------------------|:-----------------:|:-----------------:|:---------------------:|:-------------------:|
| 1 | R1: Mobile Sticky Add-to-Cart | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 2 | R2: Complete the Ritual Cross-Sells | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ |
| 3 | R3: Multi-Tier Shipping & Gift Progress | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ | ✓ |
| 4 | R4: Recently Viewed Products Carousel | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ | ✓ |
| 5 | R5: Google Merchant Rich JSON-LD | ORIGINAL_REQUEST §R5 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- **Unit Tests**: Node.js test runner `scripts/run-unit-tests.js` executing `scripts/*.test.js`.
- **Static QA Suite**: `node scripts/qa-check.js` validating syntax, JSON-LD, pricing, and markup across all files.
- **Integration Tests**: `node scripts/run-integration-tests.js` executing Puppeteer suites on dedicated ports:
  - `scripts/puppeteer_tests.js`: Multi-viewport (Desktop, Tablet, Mobile), sticky bar scroll behavior, 1-click ritual bundle adds.
  - `scripts/extended_qa_test.js`: Rapid clicks, modal bundle adds, cart drawer thresholds.
  - `scripts/a11y-check.js`: Automated axe-core WCAG 2.2 AA audit on all routes with 0 violations allowed.
  - `scripts/reveal-check.js`: Scroll reveal animation checks.
- **Cross-Browser Gate**: `node scripts/cross-browser-check.js` running Playwright across Chromium, Firefox, WebKit, Mobile Safari, Mobile Chrome.

## Coverage Goals
- Tier 1: >= 5 test cases per feature (Total >= 25)
- Tier 2: >= 5 boundary/corner test cases per feature (Total >= 25)
- Tier 3: Pairwise feature combination tests (Total >= 5)
- Tier 4: Realistic end-to-end shopping workflows (Total >= 5)
- Total E2E test target: 60+ rigorous automated assertions.
