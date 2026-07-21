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
- [Web ingress runtime](/platformclaw/web-ingress-runtime)
- [Web login bootstrap plan](/platformclaw/web-login-bootstrap-plan)
- [Private downstream CI](/platformclaw/private-downstream-ci)
- [Windows main preview](/platformclaw/windows-main-preview)

The first five implementation slices are in the private
`packages/platformclaw-control-plane` package. They contain contracts, an
in-memory store, the approved SQLite v1 persistent store, the employee-auth
adapter, opaque browser-session service, browser-auth HTTP boundary, personal
agent provisioning adapter, fail-closed Web Gateway policy proxy, and the
protocol-compatible Web ingress listener. The employee login shell and
session-gated upstream Control UI document host are also implemented.
Production deployment composition and the restricted Control UI adapter remain
later work.

The VM execution backend is a later phase. It depends on Phase 1 because the
sandbox must resolve an authenticated agent owner before selecting a VM profile
or credential.

## Maintenance rules

- Keep current behavior, approved decisions, proposals, and open decisions
  visibly separate.
- Cite the upstream extension point that supports every proposed integration.
- Keep enterprise-only behavior outside OpenClaw core when a plugin, binding,
  or control-plane boundary is sufficient.
- Never include credentials, private hostnames, employee records, or production
  identifiers in these documents.
