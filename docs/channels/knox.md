---
summary: "Connect PlatformClaw agents to Samsung Knox Teams through the CDEP relay"
read_when:
  - You are configuring or troubleshooting the PlatformClaw Knox Teams channel
  - You need the CDEP Knox relay integration contract
title: "Knox Teams"
---

# Knox Teams

PlatformClaw connects Samsung Knox Teams through the private `knox` channel
plugin and the CDEP Knox relay. The PlatformClaw deployment owns the plugin and
its credentials; CDEP owns Knox-facing transport and cryptography.

For endpoint, authentication, payload, retry, routing, and deployment details,
follow the [Knox Proxy integration contract](/platformclaw/knox-proxy-spec).
