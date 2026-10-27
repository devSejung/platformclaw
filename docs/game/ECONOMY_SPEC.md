---
summary: "Single-pool difficulty, timing-finish rewards and shared-wallet implications"
read_when:
  - Reviewing species difficulty, timing-finish rewards, or wallet effects
title: "Fishing economic specification"
---

# Fishing economic specification

The latest product contract is manual fishing with immediate shared-G credit.
There is no inventory/sale stage, automatic mode, equipment cost, region fee or
separate 23-second cast cooldown. All forty species belong to a single theme/pool; no region selector remains.
G has no cash value. No fishing signup grant is added to the existing wallet.

## Canonical rewards

The source is `packages/platformclaw-control-plane/src/data/economy/fishing.json`.
It owns one pool of forty species, explicit difficulty 1–10 and base reward
values. `probabilityWeight` retains each original species weight; the single pool
normalizes by their total, 40,000, rather than selecting a region. Regional
tables/selection are removed. The preceding pool's conditional base-value EV was
154.905 G. The final direction uses original prices divided by10, targeting
roughly15G per successful catch before finish accuracy; the raw table EV is15.4905G.
Fresh final sampling remains required. Earlier/25,/20 and/16 results are
historical. Neither the old
pool nor old four-region EV proves the revised income or finish-adjusted return.

The size/hook base reward is
`max(1, round(basePrice * (85 + 30 * t) * qualityPercent / 10000))`, where `t` is
the normalized issued size draw and qualityPercent is110 for PERFECT or100 for
GOOD. The integer-percent ordering follows the canonical calculation, including
rounding boundaries. The won fight
starts a separate four-second back-and-forth timing finish. Server-evaluated
accuracy is in [0, 1]; final reward is `round(baseGold * (1 + accuracy))`, a
1–2× multiplier. `calculateFishingFinishRewardGold` owns this calculation.

The public completed catch has final `rewardGold`, `accuracy` and
`bonusMultiplier`. There is no sale-price alias or later sale operation.
A fight win alone grants no G. Explicit finish pays its measured accuracy; an
expired four-second finish pays the baseline 1× automatically, once. Completed
reward, catch/record state and wallet ledger commit atomically. A miss/escape
grants no G.
The server pins GOOD/PERFECT base quotes privately when issuing an attempt.
Changing canonical prices therefore affects new rounds, while an already issued
round retains its quote. The snapshot exposes neither private reward quotes nor
client-selected payout amounts. Existing earned gold and records remain intact.

Do not publish a guaranteed return or reuse old regional/G-hour/progression
estimates. Real income depends on the single-pool probabilities, individual
species difficulty, hook success, finish accuracy and measured round time.

## Timing and authority

The server controls attempt issuance, bite deadlines, hook judgment and tension
replay. The final hook window is1500ms;−100..100ms is PERFECT, later valid
input through1500ms is GOOD, and input after that deadline is a miss. At most
one account-bound round is active. After a terminal round there
is no independent fixed 23-second issuance delay. Natural casting, waiting,
fighting and landing remain part of the interaction; repeated requests cannot
skip these states or award another catch.

There is one baseline control model without equipment levels. Species establishes
the baseline difficulty; `resolveFishingDifficulty(fishId, lengthCm)` incorporates
the issued individual's normalized size into an integer1–10 challenge. Larger
individuals of a species are harder; better species retain harder baselines.
Rarity alone does not define the fight. Each attempt has zero to five irregular nibble cues before its genuine bite. The won
fight starts a back-and-forth timing bar; authenticated `finish(requestId,
attemptId)` stops it using server time, without client accuracy or timestamps.
`fishingFinishPosition` and `resolveFishingFinish` are the shared pure rules.
The current species, length and rarity stay private until capture; `fishId`,
`fishLengthCm` and `rarity` are absent from the public attempt. Only behavior and
resolved difficulty become public after hook. The pre-catch silhouette is neutral,
and completed result length controls the revealed fish's size. Fight losses retain
`escapeReason` as `line_broken`, `slack` or `timeout` and grant no G. Replay uses
`replayFishingFight(seed, difficulty, inputs, elapsedMs, behavior)`. Client clocks, bar coordinates,
DOM changes and claimed results cannot determine gold. Duplicate terminal
requests return current state while preserving the accepted effect exactly once.

## Shared-game effect

The canonical owner remains `SqliteGameEconomy`, using
`baseball_game_progress.gold/revision` and `game_gold_transactions`.
The latest baseball rules award5G per hit and8G per homer. Every third
consecutive homer adds10G, and every fifth cumulative homer adds another10G.
Both bonuses stack on the same plate appearance: a qualifying fifteenth
consecutive homer can award28G. Existing accepted rewards are not repriced.
Racing uses that same balance and applies its existing 3% payout deduction.
Its payout rules and existing purchase prices remain unchanged.

Fishing adds a new producer accessible to their purchases. The single pool has no equipment/location entry gate, so every species can
contribute to shared income from the first round.
The [balance report](/game/BALANCE_REPORT) must quantify current conditional
rewards and observed timing without recycling removed auto/progression models.

Proof must cover one-time reward credit, immutable receipt replay, account
isolation, simultaneous tabs, reconnect/restart, ledger totals and existing
baseball/racing behavior. A simulation pass alone does not establish these facts.

## Existing fishing state conversion

The one-time transactional conversion preserves earned G, catch/record history
and sibling state. Previously unsold catches are credited exactly once through
the canonical wallet; retired automatic state stops. Prior accepted receipts remain immutable; matching accepted requests return
current canonical state and never replay their operations. Validate this
original execution order, double migration and rollback without resetting the
shared wallet or advancing the schema version.
