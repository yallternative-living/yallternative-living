## 2026-07-19 - Added ARIA live regions and dynamic labels
**Learning:** Found that custom stateful UI elements like wishlist buttons and gift card custom amounts lacked dynamic announcements (ARIA labels / live regions) for screen readers.
**Action:** Always ensure dynamic UI changes that don't trigger focus shifts update `aria-label` appropriately or are wrapped in an `aria-live` region.
