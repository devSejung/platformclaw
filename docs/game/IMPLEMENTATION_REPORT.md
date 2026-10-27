---
summary: "Actual fishing implementation and validation evidence"
read_when:
  - Reviewing fishing delivery status and proof
title: "Fishing implementation report"
---

# Fishing implementation report

Status: the user has resumed shipping. The final candidate targets15G fishing
base rewards, hides current species/size/rarity until capture, uses a1500ms hook
window and keeps immediate Control-keydown input. The independent transparent
bottom-right overlay, random nibbles, post-fight accuracy bonus, shared gold and
rankings/records remain. Baseball pays5/8G with stacking10G streak/cumulative
bonuses. Fresh final proof, latest-main integration, autoreview and required CI
must finish before a ready PR. No clean final verdict is claimed.

The live synthetic preview remains on the earlier/16 candidate, with3445G and
eleven catches preserved at its last cutover. No further preview deployment is
authorized. Its partial browser proof and all historical runs below apply only
to their recorded revisions, including their failed gates.

## Source and environment

Base: `9570348b4c57f1de0bed6e7b9f678403dd81e97d`; branch
`feat/stickman-fishing`. The original dirty checkout remains separate.
The existing arcade entry, authenticated connection, control SQLite database and
shared wallet are reused. There is no new 500 G grant or game service.

The task-owned `fishing-proof-20261027` container uses the prepared
`fishing-proof-tools:20261027` image derived from the existing Jammy build image.
Observed runtime: Ubuntu 22.04.5, Node 24.18.0, Corepack 0.35.0, pinned pnpm 11.15.1.
Linux source/dependencies live in `fishing-proof-20261027-work`; no operator state,
company credentials or Windows dependency install is used. Docker `--init`
reaps browser children. Existing operator containers remain untouched.

Dependency preparation succeeded after one retry with the pnpm store outside
source (`/pnpm-store`); no package, lockfile or prepare hook was patched/skipped.
The initial nested acpx build had discovered the repository tsdown configuration
when its store was under source. This is environment history, not product proof.

## Previous preview checkpoint evidence

That checkpoint removed regions entirely, gave every species individual
difficulty, adds multiple random nibbles, and requires a post-fight back-and-forth
timing finish whose accuracy contributes a bonus. Its focused proof and same-state
preview were available. Its browser scenario exposed a composer-position
invalidation defect and an independent Space focus-order conflict; it was not
a passing E2E result. The composer contract is now retired; the focus repair
and new size/escape/cue behavior still need proof at the next checkpoint.

| Check                            | Result                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Latest source contracts          | Single pool, species difficulty, random nibbles and timing finish implemented                      |
| Revised focused/backend/UI proof | Ten unaffected backend files passed; affected SQLite14/14 and UI91/91 passed after bounded repairs |
| Revised type/lint proof          | Fresh type-aware checks remain unexecuted; scoped CSS style and source formatting passed           |
| Revised economic simulation      | 400,000 conditional reward samples and4,000 species fight scenarios passed                         |
| Revised real browser flow        | Failed initial composer alignment; physical finish/reward/composer scenario remains incomplete     |
| Autoreview                       | Paused. Earlier attempts failed in preflight; no clean review verdict claimed                      |
| Ready PR/exact-head CI           | Paused; none claimed                                                                               |
| Full image/export                | Pending; no transferable archive/hash claimed                                                      |

## Superseded manual-only checkpoint

Snapshot `d0625fcc33bc0e451abd22cc9f877166641a35ecc2dc98ed513955b614c0d8e3`
contained 52 paths, including the state/migration owners. Formatting passed.
Focused backend proof passed 11 files/92 tests; UI proof passed 3 files/84 tests.
The preceding four-region manual simulation completed 400,000 conditional catches
and 2,500 behavior scenarios, exit 0. These results do not cover the subsequently
requested single pool, species difficulty, random nibbles or timing finish.
Control-plane production and package-test typechecks passed. UI production
and UI-test typechecks failed on DOM `click`/`blur` handler-name collisions,
fixed-rope indexed access types and the test bridge Window assertion. Those
findings were addressed in the subsequent source cycle but have not yet been
reverified. Canonical SDK-entry preparation completed; targeted type-aware lint
then stalled without a result, and style did not run. No lint/style pass, UI
build, E2E or preview restart for that checkpoint is claimed.

## Historical focused and input proof

Before the rescope, isolated Linux focused backend proof passed 8 files/61 tests.
A subsequent affected backend run passed 5 files/30 tests; control-plane typecheck
and 425-file scoped lint passed. The quick control-plane suite passed 1704 of 1706
tests, with two exact advertised-method catalog expectations awaiting updates at
that checkpoint. That result was a failure, not a passing full gate.

The final pointer/keyboard repair passed fishing 14 focused tests. The preceding
sibling run passed baseball workshop 42 and racing 19. UI builds, precompressed
asset and performance checks completed successfully. Logs are ignored local
artifacts under `.artifacts/fishing-proof/logs/`. These runs precede the current
product revision and must not be reported as its completed checks.

The real preview exposed inherited `pointer-events: none` from the pass-through
arcade host: physical clicks hit the page behind fishing although programmatic
activation worked. Fishing explicitly opted into pointer events; scene/action
presses focused the stable region, and normal menu keys retained native behavior.
The input owner also matched the button's cast/landing guards.

In the actual app browser, computed pointer events were `auto`, a canvas-center
hit selected fishing, a real canvas click cast and kept focus, and Space produced
PERFECT with tension/progress gauges. Served `index-Ci2IaMlG.js` returned HTTP 200
and matched disk SHA-256
`5c0f1faf372e6f972841ae2751c05709d17865130ffa47f23882a79624d06aec`.
This proves that recorded input path, not the new product contract or full catch.

## Preview handoff

The existing synthetic harness uses the isolated database; its current asset and
preservation proof is recorded below after the recovered Linux checkpoint.
The BFF snapshots asset names and app HTML at startup; rebuilding the UI requires
a graceful task-harness restart with the same state before new assets are served.
The initial login was slow during personal-agent registration/config reload;
a later authenticated BFF response and active binding were observed. No separate
credential or authentication system was introduced.

The unrelated credential-free preview heartbeat can log provider HTTP 401; it is
a named follow-up in [Known issues](/game/KNOWN_ISSUES). Preserve the running
preview until the user requests/authorizes the next synchronized revision.

## Infrastructure gap at the latest freeze

During the superseded type-aware check, the preview loopback request timed out.
Task-only Docker exec, stats, graceful stop and kill requests failed at the Linux
engine API with HTTP500. A read-only task-cgroup probe through WSL also failed
with `Wsl/Service/0x8007274c`. The observed memory pressure is a diagnostic clue,
not proof that the lint process or task container exited.

The exact stalled task Docker client was identified and stopped on Windows.
No operator process/container, Docker Desktop service, daemon or WSL distribution
was restarted or terminated. The task Linux volume, SQLite/WAL, source snapshot
and generated artifacts were preserved. Recovery affecting other services needs
separate user authorization; retrying the same unavailable task APIs is not new
proof. At that incident point the single-pool/finish snapshot had not been synced,
tested, built or served in Linux; the later recovered checkpoint below supersedes
that availability gap. Resume with focused checks and the UI preview build first;
defer expensive type-aware lint to the explicitly resumed PR/review gate.

## Recovered Linux checkpoint

The user explicitly authorized Docker Desktop restart. The supported restart and
stop commands timed out; the exact `docker-desktop` distro was terminated, the
six verified installed Desktop app/backend PIDs were stopped after supported
force-stop did not finish, and the official installed app was started hidden.
Engine29.7.2 then responded. No global WSL shutdown, OS restart, operator process
cleanup, settings removal or volume deletion occurred.

The same task container/volume was restarted with a4GiB memory ceiling and no
container swap. Its init process and memory counters were verified; OOM counters
remained0 throughout this checkpoint. Source53-file manifest verification passed
53/53; archive SHA-256 is
`93128aa331cd560a34dcc661f3d0da46c70a3d37411f1db12a7c7070f02d0c85`.
Before migration, the stopped-writer database, WAL and SHM were copied together.
The actual preview held3120G/revision501, three catches, no unsold inventory and
no automatic lease; these values must survive cutover without another reward.

Fresh backend focused proof ran11 files/136 tests:132 passed and4 failed, all in
`sqlite-fishing.test.ts`. One landed-time boundary still read fighting rather
than finishing; three fractional test/finish timestamps reached the INTEGER
wallet-ledger column. Product/test owners are addressing the timing producer.
UI focused proof passed3 files/90 tests (fishing29, baseball workshop42, racing19).
Single-pool simulation passed400,000 reward samples and4,000 species fight
scenarios. Scoped CSS style and53-path formatting checks passed. Commands and
logs are in `.artifacts/fishing-proof/logs/current-*`.

No fresh type-aware lint, broad check, CI or autoreview was run. A final UI build,
preview startup, migration idempotence check and real-browser scenario still
await the bounded repair cycle; these are not passing results yet.

## Bounded repair and current preview

The landing producer and fixture now use the first observable integer server
millisecond (`Math.ceil(hookedAt + fight.elapsedMs)`). The affected SQLite file
passed14/14 tests, including one-millisecond landing/deadline boundaries, delayed
poll anchoring and INTEGER ledger time. The ten unaffected backend files retain
their earlier passing evidence; the full11-file set was not redundantly rerun.
Backend repair archive SHA-256:
`c37dbd3ee447a57696aa3ad29087f198aba1b659e7117eabc4fba91731a37f37`.

The UI retry owner now pumps the next reel edge only after acceptance; a rejected
release remains visible and waits for a real new gesture. Its affected fishing
test plus baseball/racing passed91/91 (30/42/19). UI repair archive SHA-256:
`45f476391b601bb966238b7550cecac161141713e092631c747513f4a48f736e`.
`pnpm ui:build` passed, including finalized asset sidecars and performance checks.
No type-aware lint or broad CI gate was added to this preview recovery.

The actual preview database was migrated through its canonical store owner,
read again, closed and reopened, then read a third time. All preserved3120G,
wallet revision501, three catches, earned120G and catfish45.8cm/0.73kg best record.
Schema version remained3, one migration receipt existed, and no extra G was
credited. Evidence: `.artifacts/fishing-proof/preview-migration-proof.json`.
The cold database/WAL/SHM backup remains in the task volume.

The same-state harness is running at `http://127.0.0.1:19301/platformclaw/login`.
The served asset is `index-CVXBlN3r.js`, HTTP200, SHA-256
`789b01e820d218269da9a395594882a1a61e59ca16d695dfbe8c28b5f720b8a9`, matching disk.
The Windows host login page also returned HTTP200. Task4GiB/OOM0 was verified.
This is runtime/asset/preservation proof; the latest full Chromium scenario is
still pending, and autoreview/CI/export remain paused or unexecuted as stated.

## Historical browser findings and revised proof scope

The latest headed Chromium scenario reached the real chat composer through the
About page's visible SPA back button. Initial composer alignment failed: one run
retained a1.25px gap error; the diagnostic run retained gap0/right offset−15px.
Dock bottom787/right1168 and composer top787/right1153 stayed mismatched after
the route transition, while computed bottom and the owner property were113px.
Every inspected ancestor had transform none and zoom1. A real Records button
focus change remeasured the same composer and restored gap8/right offset0.

This indicated stale position invalidation, rather than a fractional tolerance
issue. Its8px/right-aligned contract has now been explicitly retired in favor of
an independent viewport overlay. That superseded assertion is removed from the
new scenario; the recorded failure is retained as historical evidence. Diagnostic
artifacts are `.artifacts/fishing-proof/layout-observations.json`,
`layout-failure.png` and `logs/current-e2e-layout-diagnostic.log`.
The new scenario verifies fixed bottom-right viewport bounds, independence from
composer resizing, transparent rendering and native chat input. A partial
scenario must not be reported as passing E2E.

That independent run passed composer resizing, native textarea shortcut/input
preservation, opacity10/45/100, transparent sparse canvas, physical cast/focus
and random nibble presentation. Its1100.6ms visible sample observed55 distinct
frames,49.97fps, p50 interval19.2ms and p95 interval31.3ms; this is an observation,
not a60fps claim. The run then failed waiting for a Ctrl hook request. Diagnostics
showed a focused textarea, no pending/busy/stale state and the visible bite cue.
Source tracing found that the earlier casting-guard Space reached chat's document
capture type-to-compose listener before fishing's local key handler and moved
focus away. Ctrl was subsequently ignored under the intended text-entry rule.
The owner input-order repair and complete finish/reward proof remain pending.
The final size/difficulty/escape/cue revision also awaits focused and browser
proof; no extra build, test or preview restart was started after that steering.

## Verified size/feedback checkpoint and next economy change

The/25 checkpoint contained55 paths, formatted53 supported source files and
matched55/55 hashes after Linux sync. Its archive SHA-256 is
`946dd09ac9c685bd2d32b6945b91dbbaebcd4f98c281e6e61f0202acfb9cf233`.
Fresh backend proof passed11 files/145 tests, and UI proof passed3 files/97 tests
(fishing36, baseball workshop42, racing19). Simulation passed400,000reward samples
and12,000min/mid/max-size fight scenarios. Scoped CSS and source formatting passed.
The UI build passed816 sidecars and the333237B startup-gzip check, under333824B.
These results are for/25, before the subsequent/20 and baseball reward changes.

At the actual preview shutdown, its live wallet held3401G/revision505 with seven
catches and401earned G. The canonical metadata initializer preserved every wallet,
ledger entry, immutable receipt and existing gameplay fact; reopening was
idempotent and schema version stayed3. The cold DB/WAL/SHM backup is retained in
the task volume. Evidence: `.artifacts/fishing-proof/preview-size-cutover.json`.
The proof helper's first comparison failed on SQLite null-prototype rows versus
parsed JSON; normalizing row objects repaired that artifact comparison without
changing product code or database values.

The same-state preview is ready at `http://127.0.0.1:19301/platformclaw/login`.
Served `index-CYfR5hhg.js` returned200 and matched disk SHA-256
`4ba75c2cb62c9aa6a8229a4ef009baf3c8bd21bcf1aaa6dca363e00f33043104`.
Host logs are `.artifacts/fishing-proof/logs/size-*.log`; economic data is
`.artifacts/fishing-proof/SIZE_FEEDBACK_BALANCE_DATA.json`.
The next/20/baseball steering stopped further E2E before it began. Fresh affected
proof, simulation, build and browser flow await that final source checkpoint;
autoreview, broad CI and final type-aware gates remain unexecuted or paused.
