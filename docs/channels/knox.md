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

## Questions and formatted results

Knox renders questions, cards, tables, and portable actions as text. Reply to a
question with its option number or option text. For multiple choices, separate
numbers or labels with commas, such as `1, 2`. Answers to an active question,
`/approve` commands, and `/stop` can reach the running task while ordinary new
requests keep their conversation order. Approval authorization still applies.

Attachment results include readable descriptions and validated public links
when available. Private file paths, internal links, and sensitive media references
are not published. A question or progress message does not mark the task complete.

## Troubleshoot missing replies

Failure notices include a reason code and a request reference. Give both to the
operator, who can find the matching `knox.reply.outcome` Gateway log entry.
Codes distinguish empty results, filtered results, suppressed or failed delivery,
timeouts, and execution errors. An `unknown` code means the available delivery
facts do not establish a cause; it does not prove a model failure. Existing
send-policy restrictions and message-tool-only delivery do not create automatic
failure messages.
