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

The first two implementation slices are in the private
`packages/platformclaw-control-plane` package. They contain contracts, an
in-memory store, and the approved SQLite v1 persistent store. Ingress processes
remain later work.

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
