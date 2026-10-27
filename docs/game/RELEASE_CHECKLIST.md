---
summary: "Evidence required before shipping the fishing arcade addition"
read_when:
  - Preparing the fishing PR or offline image handoff
title: "Fishing release checklist"
---

# Fishing release checklist

This checklist covers the latest manual-only product contract. Earlier proof is
historical unless its exact behavior remains unchanged and is explicitly reused.
The user has resumed shipping. Complete fresh autoreview and all required gates
against the latest-main-based final revision before creating the ready PR.

- [x] Audit the existing arcade entry, selector and sibling game owners.
- [x] Preserve the dirty original checkout in a separate feature worktree.
- [x] Confirm canonical shared gold and omit a fishing starting grant.
- [ ] Verify complete manual cast, bite, hook, hold/release, landing and miss loops.
- [ ] Verify all 40 species and one forty-species probability pool and individual difficulty rules.
- [ ] Verify multiple random nibbles, genuine bite timing and increased per-species difficulty.
- [ ] Verify post-fight timing-bar stop accuracy/bonus, reconnect and duplicate stop handling.
- [ ] Credit shared G exactly once after final completion; verify ledger, records and ranking totals.
- [ ] Recast after terminal rounds without a separate 23-second cooldown.
- [ ] Remove inventory/sale/catalog/auto/equipment/unlock contracts and obsolete toggles.
- [ ] Verify account isolation, duplicate/reordered requests, multiple tabs and restart recovery.
- [ ] Preserve old catch/record history; migrate unsold rewards once, stop retired auto state and never replay old receipts.
- [ ] Rerun fixed-seed reward and behavior simulations for final size-resolved difficulty.
- [ ] Verify final/10 fishing reward averages and baseball5/8G plus stacking streak/cumulative10G bonuses, preserving old receipts.
- [ ] Inspect an independent transparent bottom-right overlay, viewport bounds and opacity/Ctrl behavior.
- [ ] Verify species/size/rarity are hidden until capture, a neutral pre-catch shadow, and actual result-length scaling after reveal.
- [ ] Verify larger individuals are harder, and better species retain harder baselines.
- [ ] Verify authoritative line-break/slack/timeout losses, recorded causes, danger zones/numeric tension and line-break animation.
- [ ] Verify a large genuine-bite exclamation beside the head and none during feints.
- [ ] Verify physical canvas hit testing, focus, Space and native menu key behavior.
- [ ] Verify small widths, zoom, system reduced motion, hidden-tab stop/return and cleanup.
- [ ] Inspect screenshots/video and record observed animation cadence without inventing FPS.
- [ ] Regress baseball/racing entry, exit, persistence, wallet, equipment and rankings.
- [ ] Pass affected focused tests, types/lint and required UI/runtime builds.
- [ ] Complete resumed fresh autoreview and ready PR/exact-head CI against the latest-main-based revision.
- [ ] Build/smoke the full existing Jammy image with all three games.
- [ ] Verify game assets need no external CDN/API/download at runtime.
- [ ] Produce transfer archive/hash/image refs from a clean approved revision.
- [ ] Record final proof gaps and backup/rollback guidance.

Main merge and company deployment require separate authorization. No company
credentials, servers or databases are used for local proof.
