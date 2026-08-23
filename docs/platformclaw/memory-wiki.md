---
summary: "PlatformClaw personal and shared Memory Wiki rollout contract"
read_when:
  - Enabling Memory Wiki for PlatformClaw employees
  - Implementing shared knowledge scopes, promotion, or approval
  - Reviewing Memory Wiki ownership and BFF policy
title: "Memory Wiki rollout"
---

# Memory Wiki rollout

PlatformClaw adopts the bundled OpenClaw `memory-wiki` plugin instead of
building a second wiki engine. The rollout keeps durable personal memory,
compiled wiki pages, and future shared knowledge as distinct product layers.

## Layer model

- `memory-core` owns personal recall, promotion, daily memory, and Dreaming.
- `memory-wiki` compiles durable sources into navigable Markdown pages with
  provenance, claims, backlinks, related pages, and reports.
- PlatformClaw owns browser authorization and the future organization scopes,
  approval workflow, and audit trail.
- Assigned-VM selection changes project execution only. Personal memory and
  wiki state remain attached to the Gateway-hosted personal Agent.

Dreaming does not curate the wiki. It consolidates the personal Agent's memory
on its configured schedule. Bridge mode lets the wiki import published memory
artifacts; structured wiki mutations still occur through native `wiki_apply`
or an explicit operator action. PR1 adds no background LLM curator.

## Delivery plan

| PR  | Capability                  | Storage and authority                                                         |
| --- | --------------------------- | ----------------------------------------------------------------------------- |
| 1   | Native personal Memory Wiki | One `vault.scope=agent` vault per personal Agent; native plugin and UI        |
| 2   | Generic multi-corpus seam   | Upstream-compatible corpus registry/query contract; no organization policy    |
| 3   | Organization read scopes    | Personal, part, group, and global corpora with PlatformClaw membership checks |
| 4   | Promotion lifecycle         | Claim-level request, approval, retirement, audit, and derived semantic links  |

Each PR leaves a deployable system. PR3 intentionally ships an empty shared
read model until PR4 adds the only authorized promotion writer; it is useful as
an authorization, query, and UI foundation but does not fabricate seed data.
Later PRs must reuse native Memory Wiki compiler and query contracts rather
than fork page rendering or search.

## PR1: personal Agent Wiki

PlatformClaw deployment enables `memory-wiki` with this managed policy:

```json5
{
  plugins: {
    slots: { memory: "memory-core" },
    entries: {
      "memory-core": {
        enabled: true,
        config: {
          dreaming: { enabled: true, frequency: "0 3 * * *" },
        },
      },
      "memory-wiki": {
        enabled: true,
        config: {
          vaultMode: "bridge",
          vault: { scope: "agent", path: "~/.openclaw/wiki" },
          bridge: { enabled: true, readMemoryArtifacts: true },
          obsidian: { useOfficialCli: false },
        },
      },
    },
  },
}
```

The deployment reconciler applies this policy to new and existing PlatformClaw
config. Operators do not need a new environment variable or manual JSON edit.
Redeploy/restart through the normal PlatformClaw deployment flow is sufficient.
The reconciler preserves unrelated plugin options but owns the values above:
global vaults, `unsafe-local`, disabled bridge imports, and official Obsidian
CLI access are incompatible with the personal multi-user boundary.
The managed memory slot is native `memory-core`; Dreaming is enabled at 03:00
using the Gateway timezone. PlatformClaw therefore requires no separate Wiki or
Dreaming toggle. Operators needing another memory engine must treat that as a
future PlatformClaw policy change, not a per-user browser setting.

PR1 exposes bounded personal RPCs to employee browsers:

- Dreaming: `doctor.memory.status`, `doctor.memory.dreamDiary`
- Wiki UI: `wiki.importInsights`, `wiki.overview`, `wiki.get`
- Personal exploration: `wiki.status`, `wiki.search`
- Personal Dreaming maintenance: `doctor.memory.backfillDreamDiary`,
  `doctor.memory.dedupeDreamDiary`, `doctor.memory.resetDreamDiary`,
  `doctor.memory.resetGroundedShortTerm`, and
  `doctor.memory.repairDreamingArtifacts`

The BFF replaces any browser-supplied `agentId` with the authenticated personal
Agent, rejects foreign IDs and unknown parameters, caps query/result/content
sizes, and removes host paths and backend-only metadata. Reset, dedupe, and
repair actions are explicit personal operations; destructive resets require a
browser confirmation. It does not expose wiki ingest, compile, apply,
unsafe-local, Obsidian command, or global `config.*` RPCs. Agents write Wiki
content through the plugin's native tools, which already run in the selected
Agent context.

Users access the feature through **Settings > Memory**. PlatformClaw groups the
native surfaces into one hub without merging their data models:

- **Memory** searches the personal Agent's durable recall, including
  `MEMORY.md` and daily memory files.
- **Personal Wiki** opens compiled Wiki pages and imported insights.
- **Dreaming** contains Overview, Dream Diary, and Activity views for scheduled
  memory consolidation.
- **Organization** contains promotion, review, and shared-knowledge lifecycle.

The hub keeps only one surface open at a time, so Dreaming and organization
administration do not create one unbounded Settings page. `memory.search`
remains personal long-term-memory search; Wiki search/page reads remain a
separate native corpus until PR2.

### PR1 acceptance

- New and upgraded deployments advertise the bounded RPC set.
- Employee A cannot request or receive Employee B's Agent data.
- Browser responses contain no workspace or vault absolute path.
- Native Dreams, Imported Insights, Wiki overview, and page preview render.
- Basic-server and assigned-VM sessions resolve the same personal wiki.
- Linux Docker smoke proves effective managed config and Gateway method
  advertisement; focused tests prove request and response projection.

## PR2: generic multi-corpus seam

PR2 introduces a plugin-neutral corpus registration and combined-query seam.
It carries stable corpus identity, owner scope, provenance, and bounded search
results without embedding PlatformClaw roles into OpenClaw core. Native
personal memory and personal Wiki become two corpora behind one query path.
No part, group, or global authorization ships in PR2.

## PR3: organization scopes

PR3 adds four logical corpus classes. Shared corpora are SQLite read models,
not host filesystem vaults:

| Scope    | Read authority                                            | Write authority             |
| -------- | --------------------------------------------------------- | --------------------------- |
| Personal | Bound employee                                            | Native personal Agent tools |
| Part     | Current part members                                      | Promotion workflow only     |
| Group    | Current group members; group leader may audit child parts | Promotion workflow only     |
| Global   | Every authenticated employee                              | Promotion workflow only     |

Ordinary group members cannot read sibling part vaults. Default search spans
every corpus authorized for the current employee and labels each result's
scope. Membership is resolved by PlatformClaw at request time; browser input
never grants scope.

The additive `organization_memory_pages` table remains under schema version 2
and is created idempotently on first use. It stores only compiler output and
bounded provenance JSON. It exposes no production write API in PR3. PR4 owns
claim submission, approval, retirement, and compilation into this table.

Authorization is evaluated for every search and page read:

- an active personal Agent must map to an active employee;
- Global pages are readable by every active employee;
- Group and Part pages require direct active membership;
- a Group leader may audit active child Parts;
- Part membership does not imply parent-Group access;
- archived scopes, retired pages, Knox/unknown Agents, and sibling Parts fail
  closed.

The private `platformclaw-org-memory` plugin adapts the Control Plane read model
to the generic memory corpus registry. It runs with the Gateway on the Basic
server, so Basic and assigned-VM execution targets see the same authorized
results. Models use `memory_search` with `corpus=all` or `corpus=wiki`.
Employee browsers use **Settings > Memory > Memories**; the BFF pins the Agent,
combines personal and organization results, and returns only virtual
`organization/<scope>/<page-id>` paths plus a display scope. Host paths,
internal provenance, scope IDs, and approval identities never reach the UI.

Deployment owns the plugin enablement. Operators need no new environment
variable: the plugin reuses the existing owner-only Control Plane handoff token
and socket. Redeploy/restart the PlatformClaw Gateway and web ingress after
upgrade. Before PR4, an empty organization result set is expected.

## PR4: promotion and lifecycle

Promotion unit is a structured claim, not an entire generated page. A request
contains source scope and claim identity, target scope, proposed text,
evidence/provenance, reason, and expected source revision. An LLM may draft or
recommend the request, but a user explicitly submits it.

For a personal source, the selector is a native personal Wiki page ID, title,
or relative path. The Control Plane resolves it through the private Gateway
with the requester's pinned personal Agent, records a canonical content
revision, and resolves it again before approval. Browser-supplied revisions,
raw `MEMORY.md` files, absolute paths, missing pages, incomplete pages, and
changed pages fail closed. Shared-source revisions come from the authoritative
organization claim row.

Approval authority:

- personal to part: target part administrator;
- part to group: target group administrator;
- group to global: PlatformClaw administrator.

Approval creates a target-scope claim linked to its immutable source claim.
The compiler rebuilds pages, backlinks, related pages, and reports from claims;
promotion does not copy an opaque page tree. Later source changes do not
silently rewrite the approved target claim. A new revision or superseding
promotion is required.

Shared claims support retirement with reason and audit history. Retired claims
leave active search/page views but keep a tombstone for provenance. Hard purge
is restricted to PlatformClaw administrators and reserved for privacy or
security removal. Semantic links are derived, rebuildable metadata: background
LLM work may suggest relationships among approved claims, but it cannot create,
promote, approve, or restore authoritative claims.

Archiving a Part or Group atomically retires its active claims and recompiles
their source links, and records immutable rejections for pending requests that
target the archived scope or a cascaded child Part. This prevents archived scopes from leaving searchable or
unpurgeable knowledge behind. PlatformClaw administrators can still list the
retired archived-scope tombstones and hard-purge them. Ordinary retirement
preserves the request payload; only hard purge redacts that payload while
retaining immutable request lineage, decision, and audit facts.

PR4 stores authoritative state in three additive, lazily ensured tables under
the existing schema version 2: immutable promotion requests, one immutable
decision per request, and revisioned organization claims. It adds no file
sidecars and no new environment variable. Approved claims compile into PR3's
`organization_memory_pages` read model; retirement removes the compiled page
from active recall, and hard purge clears claim text and evidence while keeping
the decision and audit tombstones.

The only valid edges are `personal -> part`, `part -> its parent group`, and
`group -> global`. Submission and approval both resolve current membership at
the Control Plane owner boundary. A target Part or Group leader approves its
scope; a parent Group leader retains the existing authority to administer
child Parts. Global approval and hard purge require an active PlatformClaw
administrator. Archived scopes, disabled employees, stale source revisions,
sibling groups, duplicate pending requests, and second decisions fail closed.

Employees manage the lifecycle under **Settings > Memory > Organization**. The UI
shows authorized targets, the employee's submitted requests, requests they may
review, and readable active/retired claims. The BFF exposes only these
Agent-pinned methods:

- `platformclaw.memory.lifecycle`
- `platformclaw.memory.promotion.submit`
- `platformclaw.memory.promotion.decide`
- `platformclaw.memory.claim.retire`
- `platformclaw.memory.claim.purge`

The request form searches the requester's existing personal Wiki through the
already Agent-pinned `wiki.search` and `wiki.get` boundary. Selecting a complete
page shows a preview and pre-fills the proposed claim, provenance, and reason;
the user reviews or edits those fields and explicitly submits. Advancing an
approved Part or Group claim likewise pre-fills its text and revision instead
of asking the user to retype it. Source content stays in its original language;
PlatformClaw does not translate knowledge automatically.

### Planned organization membership architecture

This section is an approved design contract, not runtime functionality shipped
by the Memory UI. Organization membership and delegated authority must be one
shared Control Plane capability used by Memory and future organization tools;
Memory must not create a parallel role store.

- The hierarchy is `Global > Group > Part`. An employee may belong to multiple
  Parts, and each Part or Group may have multiple leaders.
- PlatformClaw administrators manage all organization memberships and roles. A
  Group leader manages that Group and its child Parts, including assigning Part
  leaders. A Part leader manages only that Part and its members.
- A common capability resolver derives delegated roles such as Memory reviewer
  and Skill curator from canonical membership. Agents inherit the memberships
  and capabilities of their bound human user; an Agent never owns independent
  organization membership.
- Administrator self-approval is allowed only as an explicit audited decision.
  Membership changes, delegation, revocation, scope archival, reviews, and
  destructive actions remain attributable in the Control Plane audit trail.
- SkillHub reuses membership, capability resolution, and audit. SkillHub still
  owns skill versions, hashes, provenance, and security gates; those do not
  belong in the organization-membership owner.
- Rollout order is: common capability resolver, organization management UI,
  Memory integration, then SkillHub integration. Until those phases land, the
  existing PR4 promotion authorization remains the only runtime contract.

Organization CRUD (create, rename, archive, and hierarchy changes) belongs in
the organization management surface. Settings > Memory owns knowledge search,
promotion, review, retirement, and audit presentation only.

The first membership implementation must expose one reusable authorization
contract rather than Memory-specific roles:

| Actor                      | Managed scope             | Default delegated capabilities                         |
| -------------------------- | ------------------------- | ------------------------------------------------------ |
| PlatformClaw administrator | Every Group and Part      | Membership, leaders, Memory review, SkillHub curation  |
| Group leader               | Own Group and child Parts | Group membership, Part leaders, scoped review/curation |
| Part leader                | Own Part                  | Part membership and scoped review/curation             |
| Member                     | Assigned Groups and Parts | Read/use capabilities granted by policy                |

An employee may belong to multiple Groups or Parts. Multiple leaders are
allowed. The resolver evaluates active membership and delegation at request
time, returns explicit capabilities, and records the acting user, target scope,
decision, and reason for mutations. PlatformClaw administrators may publish
directly to Global or self-approve only through an explicit audited action.

Memory and SkillHub reuse this identity, hierarchy, membership, delegation,
revocation, archival, and audit layer. They do not reuse domain state:
organization Memory still owns claims, revisions, promotion edges, and
retirement; SkillHub still owns package versions, hashes, provenance, scans,
and publication gates.

Lifecycle lists are authorization-filtered before bounded database pagination.
The UI follows bounded page offsets with **Load more**, so company-wide traffic
cannot hide an employee's request or a reviewer's pending decision behind an
unrelated global limit.

Browser callers cannot supply an Agent or employee identity. Stable claim,
request, and managed-scope identifiers are accepted only as selectors and are
re-authorized on every operation. User IDs, approver identities, raw audit
rows, compiler provenance, database locations, and host paths are never
returned. Models continue to read approved output through the PR3 corpus and
`memory_search`; PR4 intentionally adds no model-facing write tool. An LLM may
draft text in chat, but a person must submit the request and an authorized
person must make the immutable decision.

Operators upgrade through the normal PlatformClaw deployment and restart the
Gateway/web ingress. Existing shared search stays available while the lazy
tables are created on first lifecycle use. There is no schema-version bump,
backfill command, dual-write period, or per-VM configuration. Basic-server and
assigned-VM chats use the same Gateway-owned organization memory.

## Non-goals

- No separate browser-only wiki implementation.
- No VM-local memory mirror or dual-write path.
- No automatic organization-wide publication from Dreaming.
- No browser access to arbitrary workspace files or host paths.
- No global vault shared by all personal Agents under one filesystem boundary.
