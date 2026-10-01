---
summary: "Web Spaces with shared issue pages and conversations"
read_when:
  - You configure or verify PlatformClaw team collaboration
  - You need the Space versus personal-agent security contract
title: "Team Spaces"
---

# Team Spaces

Spaces are project collaboration domains, not organization units. Any active
employee can create a Space and become its first Owner. A Space may include
people from multiple teams or parts; each part can use multiple Spaces.
No department names or fixed organization categories determine access.

## Web workflow

Open **Spaces** in the sidebar, create a Space, then use **Members and access**.
Find a person by their exact employee account ID and review the confirmed
identity before granting access. Owner, Editor, and Viewer roles are local to
this Space; they do not change organization administration or personal tools.

- Owners manage membership and roles and can contribute content.
- Editors create and edit issue Pages and send shared questions.
- Viewers read Pages, conversation history, and search results.

The left sidebar holds Spaces and issue conversations. The center shows the
conversation with its composer pinned below. Open **Notes** for the issue
context and editing, or **Members and access** for membership.

Create an issue Page and optionally create child issues from its Notes panel. Each
Page has an independent OpenClaw conversation. Its notes and conversation are
shared from the start with all Space members; sending inside the Space does
not require a separate publication confirmation. Inviting a member grants
access to existing history as well as future contributions.

Page edits use revision checks. Concurrent changes require reload instead of
overwriting another person's notes. Initial limits are 100 Spaces created per
employee, 200 members and 200 Pages per Space, and fewer than 20 nesting levels.
The first Web slice supports direct employee invitations. Organization-wide
grants, Page moves/deletion, binary attachments, and Knox integration are not
part of this slice.

## Runtime and isolation

The existing Gateway owns sessions, transcript storage, streaming, and queues.
The control plane owns Space membership and the Page-to-session binding. Each
Space has a managed logical agent, not a new VM or model server. A Page maps to
one session under that agent. Questions use the existing follow-up queue so
separate senders do not deliberately merge input into an active model turn.
Queued questions retain the admitted employee request identity until the native
queue settles, including during their later execution. Queue-admission `final`
events are not treated as completion for authorization or revocation.
The configured native queue limit still applies (20 pending questions by default).
Spaces reject a full queue rather than dropping or summarizing questions under a
different identity. A send acknowledgment can precede this asynchronous rejection;
the shared conversation reports failure and the question can be resent after a
pending answer finishes. The separate 200-request Space admission limit is not a
promise of 200 queue slots on one Page.

Space agents have a dedicated workspace, no personal bootstrap context, no
skills, no personal Memory search, and only the `space_search` and `space_get`
read tools. The admin plugin also rejects other tool calls for these managed
agents. Tool factories pin the runtime agent and run identity; model parameters
cannot select another employee or Space principal. The existing personal
Browser Gateway ownership checks remain intact.

The normal deployed Wiki Hub/internal execution-handoff service is required for
Space-agent context and recall. The Space UI can manage Pages without it, but
conversation submission fails explicitly until that existing service is
configured. Managed deployment seeds and reconciles the read-only Space tools
into personal-agent sandbox policy. Its restart validator permits only the
strict managed read-only Space shape outside the execution sandbox; personal
and room agents retain their execution isolation. No new credential or
separate database service is introduced.
Models use the Gateway configuration; this feature does not pin a model family
or import a creator's personal provider account.

## Recall and provenance

A personal agent can search only Spaces its employee may currently read. A
Space agent can search only its own Space and requires an admitted employee run.
Results link to the authorized issue and, when present, the exact source
message. Historical message authors are shown only when transcript metadata
contains a verified profile identity; missing attribution remains unknown.
An AI response is not marked as a human-verified solution.

Search reuses the existing session index. An indexing indication means recent
messages can still be absent. Page notes also participate in browser, personal-agent, and Space-agent
search, including Pages without a conversation. Note matches include surrounding
text and a revision-pinned position. Model context is bounded: issue reads return
at most 8,000 Page characters and eight 1,200-character message excerpts. When
`nextBodyOffset` is present, continue with that `bodyOffset` and the returned
Page `revision` as `pageRevision`. If the Page changes, restart from offset zero
to avoid combining different revisions. Conversation excerpts still indicate
truncation. These user-authored issue excerpts are necessary shared context,
not authority to execute tools. The Web history view loads a bounded window;
source links can request an older anchored window.

## Revocation and lifecycle

Membership is checked on reads, writes, source opening, search completion and
outgoing events. Losing membership removes discovery as well as content access.
Role changes invalidate connected clients, and removed or downgraded writers'
admitted requests are marked revoked and sent to the native cancellation API.
A self-removing Owner can still complete cancellation using the Space identity
captured by the authorized membership mutation.

Only safe shared chat text and lifecycle projections reach Space clients. Tool
payloads, reasoning, and host metadata are not forwarded. New members see old
Space contributions; removing a contributor does not erase those contributions.
Already-read or downloaded information cannot be recalled. Previously supplied
content in a personal conversation is not retroactively erased.

The schema is additive within the existing control-plane SQLite database and
does not bump its schema version. Production migration, deployment, and model
provider sign-in are separate operator actions. Validate the built image with
multiple actual employee accounts and configured model runtimes before rollout.
