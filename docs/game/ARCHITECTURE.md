---
summary: "Ownership and security boundaries for fishing in the existing arcade"
read_when:
  - Changing fishing simulation, rendering, RPC, or persistence
title: "Fishing architecture"
---

# Fishing architecture

Fishing extends the existing arcade, authenticated browser connection, shared
wallet, and control SQLite database. The current product contract is manual
fishing with a post-fight timing finish and immediate completed-catch rewards; ranking and records are its only panels.

## Responsibility map

| Owner                | Responsibility                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Shared economy data  | One forty-species pool, individual difficulty, probability weights, reward and bonus rules, economy version                |
| Pure simulation      | Random nibble/bite schedule, species difficulty, fixed-step tension replay and timing-bar accuracy, without DOM or storage |
| Browser controller   | Manual input edges, focus, bounded request state, retry, visibility and account cleanup                                    |
| Drawing and dock     | Transparent scene, accessible controls, opacity/Ctrl interaction and independent viewport bottom-right placement           |
| BFF adapter          | Allowed parameters, authenticated account binding, validation and explicit domain errors                                   |
| SQLite fishing owner | One active account-bound attempt, completed catches, personal records and immutable receipts                               |
| `SqliteGameEconomy`  | Canonical shared balance/revision and existing gold transaction ledger                                                     |

There is no inventory, sale operation, catalog, equipment progression, region
purchase or automatic-fishing lease. There is no region selection or regional data surface. Removed operations must also disappear from
RPC advertisement, parsing, production callers and tests; a hidden menu alone
does not remove a contract.

## Canonical round and reward

The server issues one account-bound attempt with pinned timing and randomness, including multiple nibble times and the genuine bite.
The browser submits input edges; it cannot choose species, price, quality,
account, reward, elapsed time or successful completion. Only one attempt can be
active for an account. A completed or missed round permits another cast without
a separate 23-second issuance cooldown. Animation and active-attempt guards
continue to prevent overlapping rounds.
The server pins a private GOOD/PERFECT reward quote at begin. New canonical
prices affect future attempts without repricing a currently issued round.

A won fight enters a timing-finish phase, not a paid catch. The server records
`finishStartedAt` and its four-second `finishDeadlineAt`, validates the stop input
against its own clock, and derives accuracy/bonus from canonical rules. The
additive `finish` RPC takes only request/attempt IDs; it accepts no client timing
or accuracy. Shared pure position/accuracy functions make browser and server
agree. Deadline expiry completes the won catch at baseline 1×, once. Do not trust client bar
coordinates, claimed accuracy or timestamps. Species difficulty must be pinned
as an explicit 1–10 value per attempt and replay identically in browser/server.
Species identity, size and rarity remain hidden until successful capture.
Only replay behavior and resolved difficulty become public after hook. Zero to five irregular
`{at, durationMs}` nibble cues are distinct from the genuine bite deadline.
The public attempt contains no `fishId`, `fishLengthCm` or `rarity` field.
Canonical resolved difficulty still incorporates the privately selected size
and species baseline. Pre-catch art uses a neutral silhouette; only the completed
result's actual length scales the caught fish. Initialization removes retired
public metadata without changing private reward quotes or accepted receipts.
Line break, slack and fight timeout remain genuine losses without a reward;
the public `escapeReason` records the authoritative failure cause.

On successful completion, consumption of the attempt, catch/record updates, shared-G
credit and its immutable receipt commit together in one synchronous SQLite
transaction. The wallet uses the existing ledger. Replaying the same request
returns fresh authoritative state without applying its accepted effect twice;
reusing that request ID with different input fails.

Rendering consumes gameplay state and never awards currency. Fixed-step replay
is independent of render FPS. The UI projects server time with a monotonic clock
for display; authoritative input times and deadlines belong to the server.

## Input and lifecycle

The arcade host intentionally passes pointer events through. Fishing explicitly
opts its interactive surface back into hit testing. A physical scene/action
press focuses the stable `role=button` scene surface; pointer release, cancellation, blur and
visibility changes release held input. Normal menu controls retain native key
semantics. Space and scene actions share animation/active-attempt guards.
The scene's existing activation semantics also prevent chat's document-capture
type-to-compose handler from stealing Space. Input ownership stays within fishing.

The small dock stays independently at the viewport bottom right, rather than
following the chat composer. Transparent drawing must not
paint a background card. The dock opacity custom property represents 10–100%, step 5, default 45%.
Plain Ctrl from the game/non-input background acts immediately on keydown for
cast, hook and finish; fighting uses keydown/up hold/release. A later chord does
not undo the first Control action while the game owns focus. Both physical
Control keys share one held state; release waits until neither remains held.

Editable controls and shortcuts retain native keyboard behavior. Keep the fixed
dock inside the viewport at small widths and zoom.
DOM controls and status remain readable and keyboard-operable.
Composer observers and automatic placement are retired by the latest direction.
The final server hook window is1500ms, with PERFECT limited to−100..100ms around
the genuine bite and GOOD through1500ms. The presentation expires the cue at
its issued deadline;
it cannot leave a false exclamation until the next1s snapshot poll. An expired
waiting input refreshes authoritative state rather than sending a late hook.
Server replay accepts real quick releases, including same-millisecond edges.
Its monotonic clock, last-edge-per-timestamp replay and48-input budget bound
input without a minimum-duration rejection that could leave held input stuck.

Exit and unmount stop RAF, polling, timers, observers and listeners. Hidden tabs
stop drawing; return refreshes account state. Client/account changes invalidate
in-flight UI continuations so old responses cannot paint another account.

## Persistence and rollback

Use additive tables in the existing control database plus idempotent first-use
schema ensure. Do not bump `user_version`, add a second database/service, or add
a JSON runtime fallback. The explicit one-time database-first conversion preserves existing wallet,
catch totals and personal records. It credits previously unsold catches exactly
once, stops retired automatic state and retains prior immutable receipts without
rerunning their accepted operations. This is a bounded
transactional migration, not a second steady-state reader or fallback. It must
not advance the schema version or erase sibling data.

Code rollback retains the current database and already committed G movements.
Restoring an old database would also erase later baseball/racing activity and
requires a separate maintenance/reconciliation decision.
