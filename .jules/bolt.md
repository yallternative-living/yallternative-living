## 2024-07-20 - High-Frequency DOM Mutations and Synchronous Storage

**Learning:** The frontend uses a MutationObserver alongside state subscriptions to aggressively monitor Snipcart's DOM for changes to apply cross-sell items and shipping progress. Because of this, seemingly cheap synchronous operations (like `JSON.parse(localStorage.getItem())` or `Array.prototype.sort()`) become significant performance bottlenecks when called inside render loops or high-frequency callbacks. Additionally, traversing the entire DOM (`document.querySelector`) inside these observers instead of scoping the query drastically impacts efficiency.

**Action:**
- Cache expensive synchronous operations (like localStorage parsing) in memory.
- Pre-sort and pre-calculate data (like cross-sell product lists and search strings) outside of frequent render/mutation paths.
- Batch rapid DOM mutations/state updates via `requestAnimationFrame`.
- Always scope DOM queries to the narrowest possible parent when inside an observer or tight loop.
