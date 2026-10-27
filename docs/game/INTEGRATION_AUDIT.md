---
summary: "Source audit for adding fishing to the existing PlatformClaw arcade"
read_when:
  - Reviewing the fishing integration and existing game ownership
title: "Fishing integration audit"
---

# Fishing integration audit

Baseline: `9570348b4c57f1de0bed6e7b9f678403dd81e97d` (`origin/main` at task start).
The original checkout contains unrelated changes and remains separate from the
`feat/stickman-fishing` worktree.

## Existing entry and game owners

| Surface         | Existing owner and observed behavior                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Gesture         | `ui/src/platformclaw/easter-egg.ts`: seven quick clicks with the existing gap window                        |
| Desktop         | `ui/src/pages/about/view.ts`: visible About mascot calls the gesture; Settings → About is `/settings/about` |
| Narrow header   | `ui/src/components/app-topbar.ts`: header brand calls the same gesture; desktop layout hides this header    |
| Selector        | `easter-egg-game.ts` and `easter-egg-arcade-view.ts`: existing game screen and dialog owners                |
| Baseball        | `easter-egg-game.ts`, `easter-egg-view.ts`, `easter-egg-workshop.ts`                                        |
| Racing          | `horse-racing-game.ts` and its existing view/betting/settings/perimeter modules                             |
| Input/lifecycle | Existing game disconnect, scope change and exit owners release input, clocks and RAF                        |

Fishing remains the third choice and returns to the same selector. It needs no
new router, hub, login, production port or service. Browser entry proof must use
the visible desktop About gesture, not a programmatic click on a hidden header.

## Current feature boundary

The latest user instruction supersedes the original progression spec: manual
rounds use individual difficulty and random nibble schedules, then grant shared G
once after their post-fight timing finish; all forty species share a single pool without region selection; only
rankings and records remain. Inventory, sales, catalog, automatic fishing,
equipment/unlock rules, extra cooldown and sound/motion/size toggles are removed
from production contracts as well as visible menus.
The final source also hides current species/size/rarity until capture, targets
about15G base rewards with original prices divided by10, and issues a1500ms hook
window. These replace earlier preview contracts and require fresh final proof.

The small transparent dock stays independently at the viewport bottom right
and owns opacity/Ctrl interaction. Composer placement/observers are retired by
the latest direction. The arcade host deliberately has `pointer-events: none`; fishing
must explicitly receive pointer events on its interactive surface, matching the
existing racing boundary. The real preview confirmed that omitting this opt-in
causes physical clicks to hit the page behind the game even though programmatic
activation works.

## Authenticated storage and shared gold

The existing `GatewayBrowserClient` and authenticated BFF bind requests to the
server-resolved user. `browser-gateway-policy.ts` declares allowed methods and
parameters; `browser-gateway-proxy.ts` owns dispatch; `web-ingress-runtime.ts`
composes `auth.store.fishing` in the existing control-plane runtime.

All package paths in this section are under `packages/platformclaw-control-plane/src/`.
Baseball ownership is `baseball-contracts.ts`, `browser-gateway-baseball.ts`,
`sqlite-store-baseball.ts` and `sqlite-schema-baseball.ts`. Racing ownership is
`horse-racing-contracts.ts`, `browser-gateway-horse-racing.ts`,
`sqlite-horse-racing.ts` and `sqlite-schema-horse-racing.ts`.
`SqliteGameEconomy` reads `baseball_game_progress.gold/revision` and records
`game_gold_transactions`. Fishing uses that owner and grants no starting 500 G.

The latest user direction also updates baseball rewards to hit5G/homer8G,
plus10G each third consecutive homer and10G each fifth cumulative homer, stacking
when both qualify. Equipment and racing payouts remain unchanged.
Immediately available fishing rewards can finance their purchases faster; this
is a visible shared-economy effect, not a separate fishing currency.

## Runtime and proof

`scripts/platformclaw-build.mjs` owns the existing Jammy image/export pipeline;
`docker/platformclaw-runtime/` owns deployment. Fishing ships in that same image.
`scripts/platformclaw-racing-preview.ts` composes synthetic employee auth, a real
Gateway/BFF and isolated SQLite state. Its test funding is not a product reward.

The BFF's `web-assets.ts` snapshots the asset map/application document at startup.
Rebuilding `dist/control-ui` requires a task harness restart before new hashed
assets are served. Preserve synthetic state on restart; do not touch operator
containers. Additive fishing tables do not bump `PRAGMA user_version` or replace
the shared wallet. Current focused proof, simulation, UI build and same-state
preview preservation are recorded in [Implementation report](/game/IMPLEMENTATION_REPORT).
The superseded composer browser scenario exposed stale-coordinate invalidation;
that contract has since been retired, and its failure remains historical evidence.
The independent Space/type-to-compose focus finding still requires final input
proof. The new size/difficulty, escape-cause and bite-cue revision awaits its
coordinated source checkpoint and focused/browser validation.
Older preview evidence covers only its recorded revision.
