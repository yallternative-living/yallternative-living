# Y'allternative Living — AI Agent Guidance & Operating Protocol (AGENTS.md)

This document provides project context, tech stack rules, data-flow pipelines, security constraints, and automated verification protocols for **all AI agents** (single-agent CLI sessions, IDE assistants like Cursor/Aider/Devin, and multi-agent teams) working in the **Y'allternative Living** repository.

---

## 1. Project Context & Brand Identity

- **Brand**: Y'allternative Living (Landrum, SC) — Queer-owned, Southern-raised, Alt-inspired small-batch handmade self-care, salves, soaks, body care, and apparel.
- **Voice**: Warm, funny, irreverent, proudly Southern & proudly queer. Goth meets Southern. Never mean or mocking.
- **Architecture**: 100% static HTML/CSS/JS with zero runtime framework dependencies. Fast, mobile-first, offline-capable via `sw.js`.
- **Integrations**: Stripe Checkout via a Cloudflare Worker (`workers/checkout.js`) + on-site cart (`assets/js/cart.js`), Formspree (contact & review submissions), Umami (cookieless analytics + conversion events), Kit/ConvertKit (newsletter), Tawk.to (live chat), Sveltia CMS (`/admin`).

---

## 2. Core Architectural Principles & Invariants

1. **Single Source of Truth (`assets/data/`)**:
   - Primary data sources: `assets/data/products.json`, `assets/data/events.json`, `assets/data/content.json`, `assets/data/site-reviews.json`.
   - **DO NOT** edit derived JS files (`assets/js/products-data.js`, `assets/js/events-data.js`, etc.) or product HTML files in `products/` directly. Edit the JSON source files in `assets/data/` and run `npm run build-data`.

2. **HTML Comment Markers**:
   - Dynamic copy uses HTML comment wrappers (e.g., `<!--YL:productCount-->13<!--/YL:productCount-->`).
   - Keep markers intact so `scripts/build-site-data.js` can replace inner text automatically.

3. **Security Headers Synchronization**:
   - Security headers and Content Security Policy (CSP) policies in `_headers`, `netlify.toml`, and `vercel.json` **must remain byte-identical**.
   - If CSP or security rules change, update via `npm run build-security-headers`.

4. **Self-Contained Integration Testing**:
   - `scripts/puppeteer_tests.js` automatically manages its own local HTTP static server lifecycle on port `8082`.
   - Never assume an external HTTP server is already running when triggering integration tests.

5. **One Lockfile (`package-lock.json`)**:
   - npm is this project's package manager -- the CI workflows, the docs and every `npm run ...` script assume it. `package-lock.json` is the only lockfile that may exist; do not add `pnpm-lock.yaml`, `yarn.lock` or `bun.lockb`.
   - Netlify chooses its package manager from whichever lockfile it finds and installs with `--frozen-lockfile`. A stale second lockfile silently becomes the one that decides production deploys: an out-of-date `pnpm-lock.yaml` broke every deploy for nine days while `npm test` stayed green.
   - After any change to `package.json`'s `dependencies`/`devDependencies`, run `npm install` so the lockfile follows. `npm test` asserts both invariants.

6. **No Superficial Fixes**:
   - Never comment out failing QA assertions, swallow errors silently, or use arbitrary dummy fallbacks to force a passing test.
   - The same rule applies to the CI workflows in `.github/workflows/`: a quality gate there must be allowed to fail the run. Never append `|| true` (or an equivalent) to a test step to keep a deploy green.

---

## 3. Maintenance Scripts & Verification Pipeline

Every AI agent MUST execute and pass all quality gates before finalizing changes:

| Step | Command | Script Source | Purpose & Action |
| :---: | :--- | :--- | :--- |
| **1** | `npm run build-data` | `node scripts/build-site-data.js` | Compiles JSON files into derived JS data objects, updates static HTML comment markers, generates `products/*.html`, `sitemap.xml`, `robots.txt`, and `llms.txt`. |
| **2** | `npm run optimize-images` | `node scripts/optimize-images.js` | *(Optional when adding new images)* Generates responsive AVIF/WebP image variants via Sharp and updates `assets/js/image-manifest.js`. |
| **3** | `npm run build-security-headers` | `node scripts/build-security-headers.js` | Syncs CSP rules across `_headers`, `netlify.toml`, and `vercel.json`. |
| **4** | `npm run test` | `node scripts/run-unit-tests.js && node scripts/qa-check.js` | Runs every `scripts/*.test.js` unit suite (cart pricing, Worker checkout/tax/gift-card math, build-data compiler, main.js, social-feed sync, translator), then 330+ static quality assertions (JSON-LD validation, gift-card/bundle pricing, CSP coverage, FAQ match, rating calculations, comment traps). |
| **5** | `npm run lint` | `eslint scripts assets/js` | Enforces JavaScript quality and syntax standards. |
| **6** | `npm run format:check` | `prettier --check` | Validates formatting across scripts and client JS files. |
| **7** | `npm run test:integration` | `puppeteer_tests.js`, `extended_qa_test.js`, `security_stress_test.js`, `a11y-check.js` | Runs automated headless browser tests across Desktop (1200x800), **Tablet (768x1024)**, and Mobile (375x667) viewports (link integrity, menu drawer, form intercept, on-site cart add-to-cart flow, XSS/CSP stress), then the axe-core accessibility gate. |

> **Accessibility gate**: `scripts/a11y-check.js` scans every top-level and generated product page with axe-core against `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` and `best-practice`, and fails on **any** violation -- the site is currently at zero, and that is the bar to keep. Do not narrow that tag list to make a run pass: scanning `wcag2aa` alone is exactly how a serious WCAG 2.2 target-size failure sat unnoticed on all 19 product pages. `scripts/run_audit.js` is the richer hand-run report (screenshots, per-viewport overflow, transitions); the gate is what runs on every push.

---

## 4. Multi-Agent & Subagent System Architecture

When executing in a multi-agent mode (e.g. `/teamwork-preview` or `/browser`), agent roles and workflow boundaries are structured as follows:

```mermaid
graph TD
    User["User / Agent"] --> Sentinel["Project Sentinel"]
    User --> Orchestrator["Project Orchestrator"]
    Orchestrator --> Explorers["Explorers"]
    Orchestrator --> Workers["Workers"]
    Orchestrator --> Reviewers["Reviewers"]
    Orchestrator --> Auditor["Auditor / Challenger"]
    User --> BrowserAuditor["Browser Subagent (Visual & Interaction QA)"]
```

- **Project Sentinel**: Tracks requirements, logs liveness, and manages audit trails in `.agents/`.
- **Project Orchestrator**: Decomposes milestones (R1, R2, R3) and coordinates subagents.
- **Explorers**: Read-only research, file inspection, link checking, and structural audit.
- **Workers**: Code modification, script fixes, and feature implementation.
- **Reviewers & Auditor**: Objective peer review of diffs against acceptance criteria.
- **Browser Auditor**: Puppeteer/Chrome automation testing across Desktop (1280x800), **Tablet (768x1024)**, and Mobile (375x812) viewports, verifying DOM interaction, grid reflow, and recording visual proof.
