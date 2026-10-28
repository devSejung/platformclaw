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

Legacy LDAP/SAML department, part, and groups remain identity metadata. Only the
trusted, structured `org` claim described below supplies automatic membership.
PlatformClaw managed scopes and memberships remain authorization authority.

### Directory organization synchronization

Successful LDAP and SAML browser sign-in synchronizes version-1 `org` claims
from ldap-login when `source` is `aicm` and `part.id` is present. SAML claims
are consumed only after signature, issuer, audience, lifetime and replay
validation. Test-account sign-in never changes organizations or memberships.
Missing claims, unknown versions, mapping claims and missing parts leave
existing membership intact; legacy part strings are not parsed for this feature.

Automatic scope keys are `team:<team name>`, `group:<group.id>` and
`aicm-part:<part.id>`. Stable IDs preserve scope identity across display-name
changes. Team names are their keys, so a renamed Team creates a new Team.
Different external keys may have equal display names; Settings shows their
full path and external key. Existing manually created scopes are not adopted
by matching their names, and manual-only name uniqueness remains enforced.

The hierarchy stays Team > Group > Part. Known existing parents complete
partial claims. A missing Group preserves the existing Part parent. If a new
scope's required parent cannot be resolved, the entire synchronization is
deferred without creating partial scopes or changing membership. A later
successful sign-in can complete it. Source timestamps are checked per user
and per shared scope; older or conflicting same-timestamp changes do not
overwrite newer names, parentage or assignments.

Only a direct Part membership is added. Group and Team access uses the existing
ancestor policy. Moving employees removes only their ldap-login membership
source. Existing manual memberships and leader roles survive, including when
an administrator explicitly retains an automatic membership through Settings.
Removing the last source clears its primary-scope selection; a retained manual
membership keeps that selection. Satisfied pending join requests are cancelled
with an explicit directory-supplied-membership reason, without inventing a
human approval. Shared Wiki access is reconciled in the same transaction.

Settings marks automatic scopes and memberships as managed by ldap-login.
Automatic scope names and structure cannot be edited or archived through the
management API, and empty scopes are retained. An inactive lineage is never
automatically restored. Directory parent changes update effective ancestor and
leader authority for every affected member; consumer authorization continues
to use current scope IDs and lineage.

Organization changes, membership movement and successful-sync timestamps commit
atomically after browser-session success. Failures roll back organization
changes, log a redacted diagnostic, and leave sign-in successful. Retry occurs
on the next successful sign-in; there is no background queue or bulk backfill.

This feature retains control schema v3. Nullable identity/provenance columns,
a user sync-state table and manual-only name indexes preserve existing IDs,
roles and hierarchy for older readers. Older applications do not enforce the
new automatic-management protections or preserve directory provenance when
performing writes; downgrading loses those feature guarantees. No legacy state
files or parallel organization authority are introduced.

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

| Service   | Shared organization capability                                 | Domain state that remains with the service                                          |
| --------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Wiki Hub  | Exact direct organization membership and employee/scope status | Personal/Shared documents, explicit Wiki grants, access requests, indexes and links |
| Skill Hub | Current selected-audience membership and active lineage        | Stable entries, sharing, ownership, versions, scan evidence, and installations      |
| Agent     | Organization-aware assignment and administration               | Agent identity, workspace, sessions, and runtime state                              |
| VM        | Future scope-based allocation or administration checks         | Hosts, credentials, execution profiles, and target state                            |
| MCP       | Future scope visibility and credential-policy checks           | Server registry, tool policy, OAuth, and credential material                        |
| Knox      | Future organization-aware product permissions                  | Channel identity, room bindings, delivery, and room Agent state                     |

This consumer table is illustrative, not exhaustive. Board, approval history,
operations, and every later PlatformClaw service that needs organization policy
must use the same owner boundary instead of adding a service-local membership
model.

Organization scope never collapses every service operation into one permission.
Skill Hub defaults new entries to Public for every active company user, including
users without an organization. Publishers may choose any active Team, Group, or
Part, including another organization, as a Selected audience. Selected users and
covered organization members form a union. A selected Team includes its Groups
and Parts; a selected Group includes its Parts. Current active membership and
lineage determine later reads and downloads.

Skill Hub has no employee-facing namespaces or organization eligibility rule for
ownership. Sharing never grants editing: the single owner manages the entry;
administrators use a reasoned, audited operating exception. A reader may inspect
ordinary version history, while management events remain owner/administrator-only.
A primary organization does not replace the Public default. Room use remains
Public-only even when the sender has Selected, owner, or administrator access.
See [Skill Hub product policy](/platformclaw/skill-hub-policy).

The Knox transport term `group` or a Knox group chat is not a managed
PlatformClaw Group. No room, channel, directory group, or mutable display name
implicitly creates or selects a managed organization scope.

## Wiki authority and personal privacy

Wiki Hub replaces the former organization knowledge system. Its destructive
company-image startup cleanup removes old claims, promotion/review records and
derived knowledge while preserving this organization directory and memberships.
See [Wiki Hub upgrade behavior](/platformclaw/memory-wiki#upgrade-deletes-retired-organization-knowledge).

Shared Wiki Owners explicitly choose Reader, Editor or Owner grants for users
or organizations. An organization grant applies only to direct members of the
selected Team, Group or Part. General upward organization access, leadership
and administrator status do not implicitly add Wiki content access. The highest
current direct-user or exact-organization grant wins. Personal Wiki remains
private; sharing is an explicit reviewed document copy.

Wiki membership removal protects the last effective Owner, but employee
disablement, organization departure and archival are authoritative and proceed.
An ownerless Wiki retains its existing remaining grants. An administrator may
explicitly assign a replacement Owner through an audited recovery action;
recovery permission does not itself grant document read access. Existing
organization lifecycle, last-administrator and Skill Hub policies remain intact.

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
- Skill Hub Selected audiences recheck active scope lineage immediately. Recorded
  sharing stays attached to the skill; archival never makes it Public. Wiki
  grants are revoked with membership; an ownerless Wiki uses explicit admin recovery.

Scopes and organization records are not hard-deleted during normal operation.
Privacy or security purge is administrator-only and must preserve a redacted
audit tombstone where policy permits. Restoring a scope or moving a manually
managed scope requires an explicit administrator action that revalidates parentage, names, dependent assets, and
effective memberships. Trusted directory synchronization owns the automatic
parent changes above; manual scope move and restore remain deferred.

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
8. Historically, rebuild Skill Hub namespace bindings to distinguish Global,
   Team, Group, and Part, preserving existing domain state. This was the v3
   organization migration contract. The later canonical Skill Hub catalog retires
   those bindings and ceilings as runtime authority. Its separate one-time
   migration makes eligible existing skills Public, preserves native versions
   and links, and leaves later user restrictions intact. It does not rerun the
   historical namespace activation rules. See
   [Skill Hub migration](/platformclaw/skill-hub-architecture#storage-and-retention).
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

The schema-v3 migration historically preserved approved Group-to-Global Memory claims.
The later Wiki Hub startup cleanup intentionally deletes that retired knowledge
corpus; the following migration history does not preserve it in current runtime. Existing pending
Group-to-Global requests remain visible and may receive one administrator
decision under their immutable original contract; new ordinary-user requests
after cutover follow Group-to-Team-to-Global. Runtime uses only the v3 shape
after migration: there is no dual write, fallback reader, or silent
compatibility alias. Rollback requires restoring the pre-migration application
and database backup together.

## Delivery sequence

| PR  | Scope                                                                                       |
| --- | ------------------------------------------------------------------------------------------- |
| 1   | This architecture, policy reconciliation, migration contract, and rollout boundaries        |
| 2   | Schema v3, `OrganizationService`, `AuthorizationService`, and service-level unit tests      |
| 3   | Authenticated organization BFF/API, join-request endpoints, and response projection         |
| 4   | Historical Skill Hub organization conversion, later replaced by canonical per-skill sharing |
| 5   | Memory search, promotion, review, and lifecycle conversion with Team scopes                 |
| 6A  | Settings organization tree, membership, leader, and structure management with EN/KO UX      |
| 6B  | First-login join request and review inbox UX                                                |
| 6C  | Organization audit explorer and remaining operational UX                                    |

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

Manual scope move and restore remain deferred. Moving an active subtree changes
effective Memory lineage, Skill Hub Selected audiences, and reviewer
authority; those operations will ship only with cross-consumer lifecycle proof.

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
