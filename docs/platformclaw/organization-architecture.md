---
summary: "Approved organization hierarchy, membership, authorization, and migration contract for PlatformClaw services"
read_when:
  - Implementing organization, membership, join-request, or delegated authorization behavior
  - Connecting Memory, Skill Hub, Agent, VM, MCP, Knox, or another service to organization policy
  - Migrating PlatformClaw control schema v2 organization data
title: "PlatformClaw organization architecture"
---

# PlatformClaw organization architecture

PlatformClaw will use one organization system across its services. The approved
hierarchy is:

```text
Global
└── Team
    └── Group
        └── Part
            └── User
```

This page is the canonical contract. Schema v3, Team scopes, join requests,
upward access inheritance, and the shared organization and authorization
services are implemented. The authenticated browser API described below is
also implemented. Skill Hub and Memory now consume this shared authorization
owner. Settings > Organization provides membership and structure management,
join requests, delegated review, and the administrator organization audit
explorer.

## Scope model

**Global** is the virtual company root. It is not a managed scope row and has no
membership rows. Every active authenticated employee may read content whose
domain policy marks it Global-readable. PlatformClaw administrator is a global
role, not a Global membership.

**Team**, **Group**, and **Part** are managed scopes:

- every Team belongs directly to Global;
- every Group has exactly one parent Team;
- every Part has exactly one parent Group; and
- a user may be a direct member of any Team, Group, or Part without being a
  direct member of a lower scope.

The first implementation fixes these three managed levels but keeps stable
scope kinds, identifiers, parent identifiers, and lineage-based service
contracts. A future approved migration may insert another managed level without
requiring Memory, Skill Hub, Agent, VM, MCP, or Knox to invent another role
store. It does not make arbitrary or cyclic hierarchies valid today.

Directory attributes such as LDAP/SAML department, part, and groups are identity
metadata and future synchronization inputs. PlatformClaw managed scopes and
memberships remain authorization authority. The first rollout does not
automatically grant access from a directory claim.

### Direct and effective membership

The database stores only direct membership. `OrganizationService` resolves
lineage, and `AuthorizationService` derives effective access at request time.

- Direct membership grants the named scope.
- Membership in a lower scope grants read/use access to its active ancestors.
- Membership in an upper scope does not grant access to descendants.
- Membership never grants access to sibling scopes.
- Multiple direct memberships are allowed at every managed level.
- A disabled user or archived scope contributes no effective access.
- A scope is effectively active only when its complete parent lineage is active.
- A PlatformClaw administrator can read and administer every organization scope
  without membership, subject to each domain's Personal-data boundary.

For this example:

```text
Team A
└── Group A1
    └── Part A1-1
```

| Direct membership | Effective organization access           | Not implied              |
| ----------------- | --------------------------------------- | ------------------------ |
| None              | Global only                             | Any Team, Group, or Part |
| Team A            | Global and Team A                       | Group A1 or Part A1-1    |
| Group A1          | Global, Team A, and Group A1            | Part A1-1                |
| Part A1-1         | Global, Team A, Group A1, and Part A1-1 | A sibling Group or Part  |

Global readability remains subject to the consuming domain's policy. It does
not grant mutation, administration, or access to another user's personal data.

### Primary scope

A user may optionally select one active direct membership as their primary
scope. It supplies a default selection for organization-aware UI, publication,
and promotion flows. It never adds authority and never removes authority from
other direct memberships.

The primary scope is cleared when that membership is removed or the scope is
archived. A user with no primary scope remains fully usable.

## Roles and delegated administration

Each managed scope may have multiple leaders. Leader is a role on a direct
membership, so a leader is also a member of that scope. Only a PlatformClaw
administrator may appoint or remove Team, Group, or Part leaders.

| Actor                      | Membership management                                     | Structural and leader management |
| -------------------------- | --------------------------------------------------------- | -------------------------------- |
| PlatformClaw administrator | Every Team, Group, and Part; may assign without a request | All scopes and leaders           |
| Team leader                | Own Team and its descendant Groups and Parts              | None                             |
| Group leader               | Own Group and its descendant Parts                        | None                             |
| Part leader                | Own Part                                                  | None                             |
| Member                     | None                                                      | None                             |

Delegated leaders may add or remove ordinary members and decide join requests
within the listed boundary. They cannot create, move, rename, archive, or
restore scopes; appoint or remove leaders; change global roles; or remove their
own leadership. Administrators can manage all Teams, Groups, and Parts, but the
last active administrator protections remain in force.

Service-specific capabilities are derived from these roles. A Team leader is
not automatically a PlatformClaw administrator, VM administrator, MCP server
administrator, or Knox administrator.

## Join requests and users with no organization

Organization membership is optional. An active employee with no Team, Group,
or Part membership can still sign in and use personal Agent, chat, personal
Memory, and other features that do not require an organization scope.

A dismissible post-login join prompt is shown to non-administrators with no
effective active managed-scope membership and no pending request, including
users whose only direct memberships belong to archived lineages. The same flow
is available under **Settings > Organization**. Skipping or dismissing it does
not block the application, and the dismissal is scoped to the current browser
session and actor.

A user may:

- search the active organization tree;
- request membership in a specific Team, Group, or Part;
- give a bounded reason for the request;
- submit requests to more than one scope;
- view pending, approved, rejected, and cancelled outcomes; and
- cancel their own pending request.

Tree search returns bounded scope identity, kind, display name, root-to-leaf
lineage, request eligibility, and self-relative management capabilities.
Ordinary applicants never receive membership rosters,
leader identities, or other users' requests. Leaders receive management data
only for their delegated subtree; administrators may inspect the whole managed
tree.

Only one pending request per user and target scope is allowed. Archived scopes,
disabled users, duplicate pending requests, and a second decision fail closed.
Approval creates direct membership only in the requested scope; effective
ancestor access is derived rather than copied into membership rows.

| Requested scope | Authorized reviewers                                              |
| --------------- | ----------------------------------------------------------------- |
| Team            | A leader of that Team or a PlatformClaw administrator             |
| Group           | A leader of that Group, a leader of its Team, or an administrator |
| Part            | A leader of that Part, its Group, its Team, or an administrator   |

A reviewer cannot approve their own request. An administrator does not need a
request to assign a user directly, but that action requires an explicit reason
and audit record. A request to a scope with no active leader remains available
to PlatformClaw administrators instead of dead-ending silently. Approval,
rejection, cancellation, and direct assignment must produce a visible result.

## Shared service boundaries

`platformclaw-control` owns the canonical organization state. Other services do
not read organization tables directly or reconstruct parent and leader policy.

### OrganizationService

`OrganizationService` owns:

- scope identity, parentage, lineage, status, and structural validation;
- direct memberships, multiple leaders, and optional primary scope;
- join-request submission, cancellation, review, and terminal state;
- membership removal and scope archival effects; and
- authoritative organization audit facts.

### AuthorizationService

`AuthorizationService` accepts a trusted authenticated actor plus a target
resource/scope and returns explicit capabilities and the facts that justified
them. Browser-supplied user IDs, Agent IDs, roles, lineage, or organization
claims are never authority. Every mutation re-resolves the current actor,
membership, scope status, and parent chain inside the authoritative operation.

Consumers keep domain ownership:

| Service     | Shared organization capability                                      | Domain state that remains with the service                         |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Memory Wiki | Scope read, review, publish, retire, and administrator capabilities | Claims, revisions, promotion edges, compilation, and provenance    |
| Skill Hub   | Namespace visibility, curation, ownership eligibility, and transfer | Packages, versions, hashes, scans, publication gates, and installs |
| Agent       | Organization-aware assignment and administration                    | Agent identity, workspace, sessions, and runtime state             |
| VM          | Future scope-based allocation or administration checks              | Hosts, credentials, execution profiles, and target state           |
| MCP         | Future scope visibility and credential-policy checks                | Server registry, tool policy, OAuth, and credential material       |
| Knox        | Future organization-aware product permissions                       | Channel identity, room bindings, delivery, and room Agent state    |

This consumer table is illustrative, not exhaustive. Board, approval history,
operations, and every later PlatformClaw service that needs organization policy
must use the same owner boundary instead of adding a service-local membership
model.

Organization scope never collapses every service operation into one permission.
For Skill Hub, Global-scoped read/install may be available to every active
employee when the skill's visibility permits, but Global publish and curation
remain administrator-only. Team/Group/Part read, install, publish, and curation
are separate capabilities derived from current membership, leadership, owner,
explicit per-user ACL, and immutable package policy. A consumer must request
the exact capability; general scope access is not a publication grant.

The Knox transport term `group` or a Knox group chat is not a managed
PlatformClaw Group. No room, channel, directory group, or mutable display name
implicitly creates or selects a managed organization scope.

## Memory authority and personal privacy

The target Memory promotion path follows the selected active organization
lineage:

```text
Personal -> Part -> Group -> Team -> Global
```

Missing lower memberships are skipped. A Group-only user can request
`Personal -> Group`; a Team-only user can request `Personal -> Team`; and an
unaffiliated user can request `Personal -> Global`. The target still requires
the reviewer authorized for that scope. Multiple memberships require the user
to select the intended organization path.

PlatformClaw administrators may:

- create or publish organization knowledge in any managed scope or Global;
- promote an organization claim directly to a higher ancestor or Global;
- promote their own Personal claim directly to an organization scope; and
- approve, reject, retire, or hard-purge organization claims according to the
  Memory lifecycle contract.

Administrator direct publication, skipped-level promotion, self-approval, and
hard purge require an explicit reason and audit record. Administrators do not
receive routine access to another user's Personal Memory or Personal Wiki. They
may review only the personal claim that the user explicitly submits for
promotion. Any future security or legal break-glass access requires a separate
approved capability and stronger audit policy.

Dreaming remains personal memory consolidation. It does not publish or promote
organization knowledge automatically.

Ordinary Memory promotion review follows the target scope:

| Promotion target | Authorized reviewers                                      |
| ---------------- | --------------------------------------------------------- |
| Part             | Part leader, ancestor Group/Team leader, or administrator |
| Group            | Group leader, ancestor Team leader, or administrator      |
| Team             | Team leader or administrator                              |
| Global           | PlatformClaw administrator only                           |

The source must belong to the selected active lineage. Review authority does
not grant routine access to Personal content that was not submitted.

## Lifecycle and audit

Normal deletion is lifecycle-based:

- removing membership removes that membership's contribution immediately;
  remaining direct memberships are re-resolved and may still grant the same
  scope through another active lineage;
- archiving a Team cascades inactivity to its Groups and Parts;
- archiving a Group cascades inactivity to its Parts;
- pending join requests for an archived target or descendant are rejected with
  a recorded reason;
- a primary scope that becomes ineffective is cleared; and
- domain assets with an owner or active lifecycle must be transferred or
  retired before archival completes.

Scopes and organization records are not hard-deleted during normal operation.
Privacy or security purge is administrator-only and must preserve a redacted
audit tombstone where policy permits. Restoring or moving a scope is an explicit
administrator action that revalidates parentage, names, dependent assets, and
effective memberships; it is not a side effect of login or directory sync.

Audit records cover at least:

- scope create, rename, move, archive, restore, and purge;
- membership add/remove and primary-scope change;
- leader appointment and removal;
- join request submit, cancel, approve, and reject;
- administrator direct assignment and override;
- organization capability denials for sensitive mutations; and
- service-level Memory and Skill Hub actions already required by their domain
  policies.

Each mutation record includes actor, action, target, timestamp, outcome, and a
bounded reason where required. Audit and notification payloads exclude personal
memory content, package content, credentials, tokens, internal URLs, and host
paths.

## Implemented schema v3 migration

The organization model uses the approved SQLite schema version change from v2
to v3. This is not an additive lazy-table change: schema v2 constrains
`managed_scopes.kind` to Group or Part and stores `parent_group_id`, so an older
runtime cannot correctly interpret Team rows or a generic parent link.

PR2 performs one atomic migration:

1. The PR2 migration owner checkpoints the WAL, creates a one-time
   SQLite-consistent pre-migration backup, and verifies both source and backup
   integrity. Migration does not begin when backup or integrity verification
   fails. Long-term backup scheduling and retention remain deployment work.
2. Rebuild `managed_scopes` with `team | group | part` and
   `parent_scope_id`, preserving immutable IDs and timestamps.
3. Create one system-marked **Unassigned Team** for migrated data. Attach every
   existing Group to it and preserve each Part's existing Group parent. The
   row uses explicit migration provenance and the oldest active administrator
   by `created_at`, then stable ID, as its accountable creator; migration aborts
   if no active administrator exists.
4. Preserve all existing direct Group/Part memberships and leader roles.
5. Add canonical primary-scope state constrained to an active direct
   membership.
6. Add immutable join-request decisions and current request state without JSON
   or filesystem sidecars.
7. Extend organization Memory scope and source constraints to include Team.
   Preserve existing claims, decisions, pages, and immutable request history.
8. Rebuild Skill Hub namespace bindings so `global | team | group | part` are
   distinct. Convert every current `team` binding with no scope ID to
   `global` with no scope ID. A real Team binding must use `team` plus a valid
   managed Team ID. Current non-administrator namespace access to `team` with no
   scope ID is denied, so migrated Global bindings start in a restricted,
   administrator-only review state. An administrator must explicitly activate
   organization-wide read/install after reviewing visibility; migration never
   turns a previous denial into access. Public catalog visibility remains the
   existing Skill Hub domain rule.
9. Set schema version 3 only after validation succeeds and commit the migration
   transaction.

The migration supports both populated and not-yet-created lazy Memory/Skill Hub
feature tables. It creates the v3 form when a table is absent and rebuilds plus
copies it when present, so deployment history does not change the resulting
schema.

Any failure before commit rolls back the transaction and leaves schema v2
authoritative. Recovery after a committed migration restores the verified
pre-migration database and the matching v2 application together; an older
runtime must not open a v3 database.

Existing approved Group-to-Global Memory claims remain valid. Existing pending
Group-to-Global requests remain visible and may receive one administrator
decision under their immutable original contract; new ordinary-user requests
after cutover follow Group-to-Team-to-Global. Runtime uses only the v3 shape
after migration: there is no dual write, fallback reader, or silent
compatibility alias. Rollback requires restoring the pre-migration application
and database backup together.

## Delivery sequence

| PR  | Scope                                                                                  |
| --- | -------------------------------------------------------------------------------------- |
| 1   | This architecture, policy reconciliation, migration contract, and rollout boundaries   |
| 2   | Schema v3, `OrganizationService`, `AuthorizationService`, and service-level unit tests |
| 3   | Authenticated organization BFF/API, join-request endpoints, and response projection    |
| 4   | Skill Hub conversion from legacy Team-as-Global to Global/Team/Group/Part              |
| 5   | Memory search, promotion, review, and lifecycle conversion with Team scopes            |
| 6A  | Settings organization tree, membership, leader, and structure management with EN/KO UX |
| 6B  | First-login join request and review inbox UX                                           |
| 6C  | Organization audit explorer and remaining operational UX                               |

PR1 through PR6C are implemented.

## Authenticated browser API

The same-origin BFF exposes `/platformclaw/api/organization` for the later
Settings UI. Every request resolves the actor from the active browser session;
browser-supplied actor IDs, roles, memberships, lineage, and authorization
facts are rejected or ignored as authority. Mutations require a same-origin
request and `application/json`, use bounded bodies and strings, and reauthorize
inside the SQLite operation that owns the state change.

The current routes are:

- `GET /context` for one consistent, bounded snapshot of the current actor's
  direct and effective scopes, primary scope, recent join outcomes, and
  authoritative unaffiliated, pending-request, prompt, review, management, and
  administrator-only audit capabilities;
- `GET /scopes` for bounded active-scope search, root-to-leaf lineage, exact
  self-relative management capabilities, and request eligibility, without
  rosters, leader identities, or internal authorization facts;
- `GET /requests/own` and `GET /requests/reviewable` for paged personal history
  and the currently authorized review inbox;
- `POST /requests`, `POST /requests/:id/cancel`, and
  `POST /requests/:id/decision` for the join lifecycle;
- `PUT /primary` for the actor's own primary direct membership;
- capability-gated scope roster and active-user search under
  `/management/scopes/:scopeId`, plus membership assignment and removal;
- administrator scope creation, rename, and archive; and
- administrator-only organization audit history with stable seek pagination,
  bounded category/outcome filters, safe actor and affected-user summaries,
  and current or archived scope labels without raw identifiers or generic
  audit details.

The audit explorer presents organization events only; Memory and Skill Hub keep
their existing domain-specific audit owners. Retention, export, and audit
deletion are not Organization UI capabilities and remain deployment-owned or
deferred.

Browser membership writes carry the roster/search snapshot's `expectedRole`
(`null` for a new member). The transactional owner rejects stale add, role, or
remove attempts with `409` before changing a newer membership.
Browser scope rename and archive writes likewise carry the scope's projected
opaque `revision`; the owner rejects a stale structural write with
`organization_scope_changed` before changing the scope.

Ordinary scope search returns opaque scope identity, kind, display name,
root-to-leaf lineage, request eligibility, and only the actor's exact
`canManageMembers`, `canManageStructure`, and `canManageLeaders` booleans.
Review and management projections
use opaque user selectors plus account ID, display name, status, and role only.
They exclude employee ID, email, department, directory groups, login history,
credentials, personal Memory, paths, and generic audit details. Request IDs
outside the actor's review subtree behave like absent resources, so the API
does not reveal foreign request state.

Scope move and restore remain deferred. Moving an active subtree changes
effective Memory and Skill Hub lineage, reviewer authority, and ownership
reach; those operations will ship only with cross-consumer lifecycle proof.

PR6A through PR6C localize their product prose, statuses, errors, and accessible labels in
Korean and English while keeping stable technical terms such as Team, Group,
Part, Memory, and Skill Hub where a forced translation would reduce clarity.

Each PR must leave current shipped paths deployable. No consumer switches to
the shared resolver before its own tests cover direct membership, ancestor
inheritance, sibling denial, archived state, multiple memberships, and
administrator behavior.

## Non-goals for PR1

- No runtime, database, BFF, UI, or deployment change.
- No automatic directory-to-membership synchronization.
- No automatic organization publication by an LLM or Dreaming.
- No mapping from Knox rooms or directory groups to managed scopes.
- No implementation was included in the original architecture-only PR1.

## See also

- [PlatformClaw architecture decisions](/platformclaw/decisions)
- [Memory Wiki rollout](/platformclaw/memory-wiki)
- [Skill Hub product policy](/platformclaw/skill-hub-policy)
- [Skill Hub architecture](/platformclaw/skill-hub-architecture)
