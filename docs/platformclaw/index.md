---
summary: "PlatformClaw architecture and migration decisions"
read_when:
  - Planning or implementing PlatformClaw capabilities
  - Reviewing the boundary between PlatformClaw and upstream OpenClaw
title: "PlatformClaw architecture"
---

# PlatformClaw architecture

PlatformClaw is a private multi-user control plane around an upstream-compatible
OpenClaw Gateway. PlatformClaw owns enterprise identity, user authorization,
agent provisioning, and enterprise execution policy. OpenClaw continues to own
agent runtime, sessions, channel routing, and plugin contracts.

The current design work is intentionally split into small phases. A phase moves
to implementation only after its security and ownership decisions are recorded.

## Current phase

Phase 1 defines the control-plane boundary used by both authenticated web users
and Knox direct or group conversations:

- [Control plane phase 1](/platformclaw/control-plane-phase-1)
- [Architecture decisions](/platformclaw/decisions)
- [Employee authentication](/platformclaw/employee-auth)
- [VM execution policy](/platformclaw/vm-execution-policy)
- [VM execution schema v2](/platformclaw/vm-execution-schema-v2)
- [VM administration](/platformclaw/vm-administration)
- [Credential broker](/platformclaw/credential-broker)
- [Web ingress runtime](/platformclaw/web-ingress-runtime)
- [Web login bootstrap plan](/platformclaw/web-login-bootstrap-plan)
- [Organization architecture](/platformclaw/organization-architecture)
- [Skill Hub integration](/platformclaw/skill-hub)
- [Skill Hub product policy](/platformclaw/skill-hub-policy)
- [Skill Hub architecture](/platformclaw/skill-hub-architecture)
- [Memory Wiki rollout](/platformclaw/memory-wiki)
- [Knox Proxy integration contract](/platformclaw/knox-proxy-spec)
- [Private downstream CI](/platformclaw/private-downstream-ci)
- [Windows main preview](/platformclaw/windows-main-preview)
- [Manual VM preview](/platformclaw/manual-vm-preview)

The first five implementation slices are in the private
`packages/platformclaw-control-plane` package. They contain contracts, an
in-memory store, the approved SQLite v1 persistent store, the employee-auth
adapter, opaque browser-session service, browser-auth HTTP boundary, personal
agent provisioning adapter, fail-closed Web Gateway policy proxy, and the
protocol-compatible Web ingress listener. The employee login shell and
session-gated upstream Control UI document host, production composition, and
restricted Control UI adapter are also implemented.

The VM execution backend foundation follows the verified 2026-07-23 upstream
synchronization. Its product and security behavior is frozen in the
[VM execution policy](/platformclaw/vm-execution-policy). The additive upstream
seam now supplies the prepared agent owner to private sandbox backends, and the
private `platformclaw-execution` plugin pins one target snapshot per backend
handle. Schema v2 adds SafeConnect endpoint, VM host, personal allocation,
server-default execution profile, and encrypted-envelope tables. Credential
cryptography, the one-shot local broker, authenticated Gateway handoff,
SafeConnect SSH backend, Docker routing, VM skill discovery, employee context,
employee work-location UI, and the non-destructive administrator VM setup
surface are implemented. The Docker smoke now supplies a test-only SafeConnect
SSH boundary and drives the real administrator assignment, employee credential,
connection-check, and VM-target handoff path. Validation against an approved
enterprise VM remains separate.

Personal MCP credential routing is implemented as a private plugin plus Control
boundary under [PC-125](/platformclaw/decisions#pc-125-store-personal-mcp-credentials-in-platformclaw-control).
Administrators keep server and tool-policy ownership; employees can supply only
credentials for approved personal servers. Credential-free and organization-wide
shared servers continue to use PC-124 without employee setup. The browser entry
point is **Settings > MCP**: administrators manage the global registry and
per-tool blocks there, while employees see only personal credentials they can
configure.

## Maintenance rules

- Keep current behavior, approved decisions, proposals, and open decisions
  visibly separate.
- Cite the upstream extension point that supports every proposed integration.
- Keep enterprise-only behavior outside OpenClaw core when a plugin, binding,
  or control-plane boundary is sufficient.
- Never include credentials, private hostnames, employee records, or production
  identifiers in these documents.
