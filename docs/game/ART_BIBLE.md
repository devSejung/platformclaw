---
summary: "Visual tokens and motion storyboard for the fishing arcade"
read_when:
  - Changing fishing art, motion, or widget layout
---

# Fishing art bible

The latest visual direction is a small independent transparent fishing overlay
at the viewport bottom right. Do not draw an opaque/off-white canvas fill, background card or
separate application frame. Preserve the small articulated fisherman, thin
waterline, restrained fish and quiet motion without covering the conversation.

| Token      | Value       | Role                                                                    |
| ---------- | ----------- | ----------------------------------------------------------------------- |
| Background | Transparent | Application remains visible through the scene and dock                  |
| Ink        | `#292c2d`   | Figure, rod and primary strokes; maintain contrast against the live app |
| Muted      | `#687775`   | Secondary copy                                                          |
| Water      | `#78a4ae`   | Surface and ripples                                                     |
| Good       | `#527766`   | Judgment and catch feedback                                             |
| Warning    | `#a9503b`   | Misses and actionable errors                                            |

Use round caps/joins, shared shoulder/hand/rod anchors and continuous line
endpoints. No downloaded sprite, web font, gradient or remote game asset is
needed. System fonts and existing icon primitives carry DOM controls. Color
alone must not communicate timing, failure or reward.

## Motion storyboard

| State         | Required motion and feedback                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Ready         | Quiet breathing and hanging line, without an automatic action                                                        |
| Prepare/cast  | Eased lift and forward sweep around the shared hand anchor                                                           |
| Splash/wait   | Float meets the actual waterline; restrained ripple and fish silhouette                                              |
| Nibble/bite   | Zero to five irregular false cues, then a large genuine-bite exclamation beside the head; no exclamation for a feint |
| Hook/fight    | GOOD/PERFECT, bent rod, continuous line, numeric tension with red danger zones and visible progress                  |
| Timing finish | A 4-second back-and-forth bar after the won fight; show stop accuracy and 1–2× reward                                |
| Landing       | Completed fish follows its line endpoint toward shore; timeout pays baseline 1×                                      |
| Success       | Brief species/size/quality/earned-G feedback and personal record                                                     |
| Miss/escape   | Clear cause; line-break animation for a broken line; another cast without extra cooldown                             |

Visual rope physics and authoritative reward replay remain separate. Pose
blending must not snap the rod between casting and waiting. System reduced
motion suppresses ambient movement while preserving actionable states and gauge
updates. No sound, motion or expanded/compact-view toggle is part of the product.

## Dock and input proof

Keep the dock fixed at the viewport bottom right and independent of composer
geometry. Keep it inside the viewport at narrow widths and zoom.
Opacity is 10–100%, step 5, default 45%, applied through the root custom property.
Plain Ctrl is a gameplay press/hold/release key outside editable input; it does
not override chat text entry or its shortcuts. Cast/hook/finish act immediately
on Control keydown; fight hold/release uses keydown/up. A later chord from the
game does not retroactively undo that first action. The visible canvas aspect is 460/165,
cropping the world above y=65 rather than adding a large blank card. Keep controls legible. Rankings and records are the
only panels; no inventory, catalog or shop artwork is required.
Use a neutral pre-catch shadow with no species, rarity or size hint. Only the
completed result's actual length scales the caught fish, so large landed
individuals visibly differ from small ones after their reveal.

The arcade parent passes pointer events through. The interactive fishing surface
must explicitly opt back in, and a real canvas click must hit the game and retain
keyboard focus. Inspect both hit testing and screenshots; DOM presence or an
accessibility invocation does not prove physical mouse interaction.
