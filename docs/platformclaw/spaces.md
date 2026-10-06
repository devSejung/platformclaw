---
summary: "Team Spaces with nested pages, owned agent sessions, and authorized Q&A recall"
read_when:
  - You configure or verify PlatformClaw team collaboration
  - You need the Space versus personal-agent security contract
title: "Team Spaces"
---

# Team Spaces

Use a Space to organize project notes and let team members' agents learn from
work done in that Space. Each person opens their own personal-agent sessions.
Members cannot open another person's session; their agents can retrieve its
questions and final answers as shared project context.

Spaces are collaboration domains, not organization units. An active employee
can create a Space and become its first Owner. A Space can include multiple
teams, and a team can use multiple Spaces.

## Create a Space and a conversation

1. Open **Spaces** in the sidebar and create a Space.
2. Open **Members and access**, search by part of an employee's name or account
   ID, and select a matching active employee. Review their name and account ID
   before confirming the invitation.
3. Create a page and use child pages to build the folder-style navigation tree.
4. Select a page and create your own conversation tab. The creation notice
   explains that questions and final answers contribute to shared agent recall.
5. Work with your personal agent using the usual composer, tools, and approvals.
   Create another tab when you need a separate conversation context.

Conversation names are local to your tabs on the selected page. If a name is
already used, creation adds the next available number, such as **New conversation2**
and **New conversation3**. Other employees' names do not reserve yours. Retrying
the same creation request returns the original conversation and its assigned name.

The left tree groups Spaces, pages, and nested pages. The center contains your
conversation tabs. **Notes** opens the selected page's shared text; **Members
and access** opens its membership controls. The existing application colors are
retained.

- Owners manage membership and roles, edit pages, and run their own sessions.
- Editors edit pages and create and run their own sessions.
- Viewers can read shared pages and their own existing session history, but
  cannot create sessions or run new turns. Changing someone to Viewer cancels
  their active Space work and removes write authority. **Load older messages**
  reads one bounded page of their own retained history at a time.

Role changes apply only to the Space. They do not grant organization
administration or another person's personal tools. Page edits use revision
checks so concurrent changes require a reload instead of overwriting notes.
**Refresh** keeps your draft and its original revision. If a newer saved revision
is available, copy your draft before choosing **Review saved revision**. Review the
saved text, then choose **Discard draft and use saved revision** to replace the
draft. Reconcile your changes before saving.
Canceling the replacement keeps the draft unchanged.
Initial page limits remain 100 Spaces created per employee, 200 members and
200 pages per Space, and fewer than 20 nesting levels.

## Session ownership and shared context

A Space-created tab is a separate durable Gateway session under its creator's
personal agent. It uses that person's configured execution target, including
their assigned VM when configured. It does not turn the VM into a shared
computer. Other members cannot execute tools, stop work, resolve questions, or
approve actions in that session.

The control plane records the session's Space, page, owner, and personal-agent
identity when it creates the session. A browser cannot attach, import, or label
an existing private session as shared. Sessions created outside Spaces remain
outside the Space recall corpus.

The owner receives the normal chat UI, tool streaming, approval display, and
stop/cancel behavior. Other people do not receive the tab, its transcript, live
events, raw tool inputs or outputs, reasoning, attachments, or approval payloads.
Native session tools also check registered Space targets, including aliases and
session IDs, before exposing raw history or mutating a session. Expanding the
operator's native session visibility does not grant raw peer Space access.
When a widened unscoped native list/search could include inaccessible Space
records, it fails with guidance to choose an exact permitted target or use Space
Q&A recall; unrelated native targets keep the existing deployment policy.
Cross-personal-agent spawning does not grant access to another employee's VM.

Only questions and final assistant text are eligible for agent recall. Interrupted
assistant partials stay in their owner's history but are excluded from shared
Q&A reads and search. Creating
a Space session therefore means that its Q&A may be cited or summarized in
another current member's agent response. Do not use it for content that must
remain confidential from those members. This is an access boundary, not an
automatic classifier that can recognize every private fact in natural language.

The Space UI and browser API disable reset, deletion, rewind, and branch
replacement for registered sessions so ordinary tab actions do not silently
rewrite shared history. Use **New conversation** for a fresh context. Ordinary
sessions outside Spaces retain their existing controls. This is not immutable
archival storage: administrator operations and separately authorized internal
session-management tools remain subject to the deployment's existing policy.

## Ask your agent about earlier work

Ask a question about earlier team discussions. Space recall tools return
bounded source excerpts with the Space, page, conversation, author when known,
and source message identity. These are evidence, not permission to use the
source author's tools and not a claim that an answer was verified.

Inside a Space-created session, recall is limited to that same Space. An agent
in an ordinary personal session can search the Spaces its employee currently
may access. Every lookup rechecks current membership; membership in one Space
never grants another Space's records. Human-facing page search does not expose
another person's personal session transcript.

Page notes participate in search, including pages with no conversation. Use short
keywords: each keyword must appear in the note's title or body, but they need not
form one consecutive phrase. Recall never inserts all Space sessions into the prompt:

- Search defaults to at most five excerpts and an 8 KiB serialized UTF-8 response.
  An explicit `limit` can request up to 20 results under a 16 KiB ceiling.
  Each search also has a shared ceiling of 40 Gateway search/history lookups
  across all queried Spaces. Exhausting it sets `windowLimited`; narrow the query
  or select a specific Space rather than treating a limited empty result as exhaustive.
- Source reads default to five message excerpts of at most 800 serialized bytes
  each and a 4,000-byte note window, with a 16 KiB response ceiling. Explicitly
  requesting more excerpts (up to eight) or a larger note window (up to 8,000
  bytes) raises the ceiling to 24 KiB.
- The byte budgets include the JSON envelope. They are conservative size
  controls, not exact model-token counts.
- Search returns `count`, `moreAvailable`, and a `nextCursor` when another page
  exists within its bounded top-20 candidate window. Use the cursor only with
  the same query and Space. `windowLimited` means narrow the query; it is not an
  exhaustive corpus cursor. Personal-session recall consistently reports this
  bounded window so completeness metadata cannot reveal hidden commentary hits.
- Use a returned `nextBodyOffset` with its page revision as `pageRevision` to
  continue notes. Restart at zero if the page changes. Use `nextMessageOffset`
  with its `messageId` to continue a message excerpt. The returned `sourceWindow`
  identifies the native source window: at most 100 messages and 16,000 text
  characters per message. Do not infer that omitted history was read.

Each lookup returns one bounded result; the wrapper does not accumulate search
pages. Repeated tool calls still become part of the person's normal conversation
history, so normal runtime compaction remains important. The existing automatic
compaction path and the owner's **Compact** action remain available. Source links
open the shared page and do not grant access to someone else's session.

## Existing shared discussions

Earlier page-level shared Q&A remains available as historical discussion under
its original Space membership rules. It is not converted into someone's
personal session or deleted. New personal tabs keep independent context and
execution identity instead of sending everyone's questions to one shared
queue. Legacy Space-agent runtime configuration remains for existing history
and authorized recall.

## Revocation and runtime verification

Membership and ownership are checked on session creation, reads, writes,
source lookup, recall completion, outgoing events, and execution. Removing a
member blocks their Space reads as well as new work. Downgrading a contributor
blocks new turns and approvals. Active and queued work is canceled through the
native Gateway lifecycle, and execution hooks revalidate before subsequent
work. Client refresh clears inaccessible Space state.

Removing a contributor does not erase their earlier Space contributions.
Already-retrieved content cannot be recalled from a member or from a personal
conversation that previously used it.

The Gateway owns transcript storage, streaming, queues, and approvals; the
control plane owns the Space registry and membership. The existing internal
execution-handoff service supplies authorized Space context and recall. The
SQLite changes are additive in the existing control-plane database and do not
advance its schema version.

Direct employee invitations are supported. Organization-group grants, page
moves/deletion, binary sharing, Knox integration, and shared VM control are
outside this workflow. Before rollout, validate the built Linux image with
multiple actual employee accounts, configured models, and both execution
targets. Mocked browser tests do not prove company authentication, provider
access, or deployment behavior. Migration, merge, release, and deployment
remain separate operator actions.
