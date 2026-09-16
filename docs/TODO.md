# Developer TODOs for Steven

## 1. Automated Event Rollover & Netlify Build Hook

**Context & Netlify Credit Economics:**
- Netlify meters production deployments in **credits** (1 production deploy = **15 credits** / $0.10).
- The Free plan includes **300 credits/month** (a ceiling of 20 deploys total).
- Netlify ignores the `[build] ignore` command for builds triggered by build hooks (every hit unconditionally builds).
- A blind daily cron calling a build hook would burn 450 credits/month and exhaust Savanna's account within 20 days.
- To protect Savanna's credits, `.github/workflows/daily-build-hook.yml` is **DORMANT** (schedule commented out), and uses `scripts/check-events-rollover.js` to only trigger when an upcoming market date has actually passed (~2–3 times/month = ~30–45 credits total instead of 450 credits).

### Activation Checklist (When Ready):
- [ ] **Step 1: Check Netlify Credit Allowance**
  - Verify Savanna's monthly credit allowance and current usage in the Netlify Dashboard (**Billing & Usage**).
- [ ] **Step 2: Create the Netlify Build Hook**
  - In Netlify Dashboard: **Sites** → `yallternative-living` → **Site configuration**.
  - Navigate to **Build & deploy** → **Continuous deployment** → **Build hooks**.
  - Click **Add build hook**:
    - **Name**: `Daily Event Rollover`
    - **Branch to build**: `main`
  - Copy the generated webhook URL (`https://api.netlify.com/build_hooks/...`).
- [ ] **Step 3: Save Secret in GitHub Repository**
  - In GitHub repository: **Settings** → **Secrets and variables** → **Actions**.
  - Click **New repository secret**:
    - **Name**: `NETLIFY_BUILD_HOOK_URL`
    - **Secret**: Paste the Netlify webhook URL from Step 2.
- [ ] **Step 4: Uncomment Schedule in GitHub Actions**
  - In `.github/workflows/daily-build-hook.yml`, uncomment lines 44–45:
    ```yaml
    schedule:
      - cron: "0 9 * * *" # 09:00 UTC = 5:00 AM EDT / 4:00 AM EST daily
    ```
- [ ] **Step 5: Test Execution**
  - In GitHub Actions: go to **Event Rollover Build Hook (Dormant)**.
  - Click **Run workflow** with `dry_run: true` to test the rollover detector without triggering Netlify.
  - If an event is expired and you want to trigger a real build, run with `dry_run: false`.
