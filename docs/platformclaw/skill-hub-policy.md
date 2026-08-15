---
summary: "Product, ownership, access, scanning, and package policy for the internal PlatformClaw Skill Hub"
read_when:
  - Implementing Skill Hub ownership, authorization, scanning, or notifications
  - Reviewing who may publish, install, force publish, or transfer a company skill
  - Choosing archive limits or scanner behavior for the internal skill catalog
title: "Skill Hub product policy"
---

# Skill Hub product policy

PlatformClaw Skill Hub is the internal, company-wide catalog for reusable Agent
skills. It is not a public marketplace. PlatformClaw identity, organization, and
authorization remain authoritative; the registry does not add a second employee
login or expose an administrator token to browsers.

This page freezes the product policy enforced by PlatformClaw and its pinned
registry runtime.

## Delivery status

| Capability                                                                  | Status  |
| --------------------------------------------------------------------------- | ------- |
| Search, version detail, direct workspace publish, and exact-version install | Current |
| Basic and assigned-VM installs as separate destinations                     | Current |
| Stable namespace bindings to company Team, Group, and Part scopes           | Current |
| Per-user skill access grants                                                | Current |
| Scanner-gated automatic publication and current risk badges                 | Current |
| Owner and administrator force publication with reason and audit             | Current |
| Immediate ownership transfer and inactive-owner reassignment                | Current |
| Persistent in-app lifecycle notifications                                   | Current |
| 500 MiB compressed package ceiling with independent expanded-content limits | Current |

## Organization and ownership

Every skill has one owning organizational unit and one accountable owner.
Organizational units use the existing PlatformClaw company hierarchy:

- **Team** is the broadest Skill Hub ownership scope.
- **Group** belongs to a Team.
- **Part** belongs to a Group.

The owner can transfer ownership immediately to another eligible active employee.
Transfer does not wait for a registry review, but it must be recorded in the audit
log and notify the old and new owners.

When an owner becomes inactive, ownership transfers to that unit's **Primary
Admin**. If no active Primary Admin exists, the skill enters an **unassigned owner
queue** for administrator resolution. The skill remains visible according to its
ACL, but ownership-required mutations are blocked until reassignment. The system
must not silently assign an arbitrary employee.

## Access control

Access is evaluated from the authenticated PlatformClaw actor on every server
request. Browser-supplied user IDs, organization IDs, paths, or registry roles are
never authority.

The authorization model combines:

1. the owning Team, Group, or Part;
2. the skill visibility;
3. explicit per-user ACL entries; and
4. owner and PlatformClaw administrator privileges.

An explicit per-user grant permits reading and installing the named skill, for
all versions or one exact version. It cannot be reshared, confer administrator
status, publish, force publication, transfer ownership, or bypass package
validation. Denials and missing grants fail closed and produce a visible result.
Namespace bindings use immutable managed-scope IDs rather than mutable Group or
Part display names. A parent Group leader governs its child Parts.

## Scan and publication policy

Normal publication is automatic after the configured scanner completes without
a blocking result. There is no routine human approval queue.

The product must show the current scan status and risk badge for the selected
version. At minimum, the state model must distinguish pending, passed, findings,
forced, failed, and unavailable scans. A badge reflects the latest completed scan
for that exact immutable version; it must not imply that a different version was
scanned.

Owners and PlatformClaw administrators may force publication for findings of any
severity. Force publication requires a non-empty reason and creates an audit
record containing the actor, skill, exact version, scanner result, reason, and
timestamp. The forced status remains visible on the version. Force publication
does not bypass archive validation, authentication, ACL enforcement, or path and
filesystem safety checks.

LLM-based scanning and VirusTotal are off. Enabling either is a separate product,
privacy, data-egress, credential, and operating-cost decision; neither may be
silently activated as a fallback.

## Package policy

The compressed ZIP ceiling is **500 MiB**. Compressed size alone is not a safe
extraction policy, so publication enforces **1 GiB expanded cumulative bytes**,
**250 MiB per file**, and **100 entries** while streaming and validating every
entry. Installation repeats the canonical Gateway archive policy before either
workspace is mutated.

All paths continue to reject traversal, absolute and drive-qualified names,
symbolic-link or junction escape, hard-link escape, malformed `SKILL.md`, and
destination collision. Size metadata from the ZIP central directory is not
trusted.

The registry multipart ceiling is 500 MiB and its expanded package policy is
1 GiB. Browser ingress writes an owner-only temporary file with a running byte
cap; it does not assemble a 500 MiB browser upload in process memory. Scanner
execution is bounded to ten minutes. At least 20 GiB of free disk is required for
a fresh embedded deployment and 5 GiB for later restarts.

## Workspace destinations

Basic and assigned-VM workspaces are separate destinations. A publish or install
operation never copies, mirrors, or falls back between them. The server resolves
the active target and serializes target changes with the final mutation. A stale
browser target fails visibly.

Publishing remains limited to a real skill in the Basic workspace until a
separately reviewed VM publish path exists. Installing an exact Hub version is
supported for both active destinations.

## Notifications and audit

The persistent in-app notification model covers:

- scan completion, findings, failure, and forced publication;
- successful publication and installation, plus failures;
- ownership transfer and inactive-owner reassignment;
- per-user ACL grant and revocation; and
- items entering or leaving the unassigned owner queue.

The header badge opens the inbox and users can mark all items read. External
email or chat delivery is intentionally not part of this release. Audit records
remain authoritative even if notification creation fails. Notifications and
audit records must not contain package content, credentials, tokens, internal
filesystem paths, or SSH material.

## See also

- [Skill Hub architecture](/platformclaw/skill-hub-architecture)
- [Operate Skill Hub](/platformclaw/skill-hub)
- [VM execution policy](/platformclaw/vm-execution-policy)
