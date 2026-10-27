---
summary: "Player experience and acceptance criteria for the fishing arcade game"
read_when:
  - Implementing or playtesting PlatformClaw fishing
title: "Fishing game design"
---

# Fishing game design

The latest user-directed revision replaces the initial collecting/progression
design. Fishing is a quiet manual game in a small independent transparent
bottom-right overlay. It keeps immediate rewards after completion, shared gold, rankings and personal
records. It has no background card, inventory, catalog, automatic mode,
equipment shop, sound/motion switches or size switch.

## Play a round

1. Open Settings → About, click the existing mascot seven times, and choose
   fishing. The narrow-screen header logo accepts the existing same gesture.
2. Use the single fishing theme and forty-species pool. There is no region
   selector, entry fee, equipment or location prerequisite.
3. Physically click the scene/action control or press Space to cast. A scene
   click focuses the stable scene button for subsequent keyboard input. Plain Ctrl
   also supports press, hold and release from the game/non-input background; chat
   text entry and its shortcuts keep their normal behavior. Cast, hook and finish
   act immediately when Ctrl goes down; fighting holds on keydown and releases
   on keyup. A later Ctrl+C chord while the game owns focus does not cancel the
   first immediate Control action.
4. Read zero to five irregular nibble cues, then hook in the genuine
   server-issued bite window. False nibbles must not award a hook. Actual hook
   timing produces PERFECT, GOOD or MISS. The final hook window is1.5seconds;
   PERFECT is limited to−100..100ms around the genuine bite, with GOOD accepted
   through1500ms. The genuine bite displays a large,
   distinct exclamation mark beside the fisherman's head; feints never show it.
5. Hold and release to reel while watching tension and progress. Each species
   has its own increased difficulty, rather than relying only on rarity. Constant
   holding, repeated keydown and rapid clicking cannot fabricate success.
   Larger individuals of the same species fight harder, and better species have
   a harder baseline. Before capture, the fish's identity and size remain hidden
   behind a neutral silhouette; the completed fish uses its actual length for
   visible size. Red danger zones and an emphasized numeric
   tension readout expose the risk. Line break, slack and timeout lose the fish;
   a recorded cause and line-break animation explain the loss.
6. After winning the fight, stop the back-and-forth timing bar. Server-evaluated
   accuracy adds a 1–2× completion multiplier; the fight alone grants no currency.
   The finish lasts four seconds; if it expires, the won catch pays baseline 1×
   automatically rather than discarding the fish.
   Read fish, size, judgment and final G. The server commits the completed catch,
   record and shared-wallet reward together, without a sale step.
7. Cast again when the round ends. There is no separate 23-second cooldown.
   Open rankings/records or return to the existing selector when desired.

All forty species belong to one pool. Canonical data owns their probabilities,
explicit difficulty 1–10 and rewards. No rod level, regional table, region filter
or unlock progression remains. Timing-bar position and accuracy share pure server/browser rules. The finish
request contains no client timestamp or claimed accuracy. Its final reward is
`round(baseGold * (1 + accuracy))`, and records/ranking include that actual G.
The final base-reward target is about15G per successful catch before finishing;
rare outcomes and size vary widely. Current species, length and rarity are not
shown or exposed through the attempt before capture.

## Overlay and controls

Keep the scene and dock transparent, without a paper fill or background card.
The existing application remains visible behind the small fisherman and water.
Keep the dock independent at the viewport bottom right; it does not follow or
observe the chat composer. Keep actionable controls reachable at small
widths and zoom. Opacity ranges from 10% to 100% in 5-point steps, initially 45%.
Ctrl is a gameplay press/hold/release key, not an opacity modifier; editable
controls and Ctrl shortcuts must retain native behavior.

The interaction surface explicitly receives pointer events despite its
pass-through arcade host. Visible cues, errors, focus and gauges must remain
legible over the application. Respect the system reduced-motion preference
without adding a motion toggle. No audio feature or audio setting is included.

## Ranking and records

Rankings and records are the only panels. Both start closed; clicking a panel
button opens it, and clicking the same button closes it. Display authoritative catch totals,
earned-G totals and personal fish-size records supported by the final contract.
Do not present retired catalog-completion goals, paid equipment, seasonal events
or unimplemented achievement rewards as live content.

Connection loss exposes recovery guidance. Unknown mutation outcomes retain the
same request ID; retry cannot award G twice. Account change, closing, switching
games, hiding the page and reconnecting must preserve server authority and clean
up local input/render work.

## Acceptance

Verify physical mouse hit testing, keyboard focus and input, all round phases,
the genuine bite versus random nibbles, individual difficulty, timing-bar accuracy
bonus, immediate shared-G credit, records/rankings, one pool, and immediate
recasting after a terminal round. Inspect actual transparent rendering and
fixed bottom-right placement, opacity/Ctrl behavior, 320px width, zoom and hidden-tab return.

Existing baseball and racing retain entry/exit, persistence, wallet, equipment and
ranking behavior. This revision is not approved by earlier proof of the superseded
product; focused checks and real browser evidence must cover the final contract.
