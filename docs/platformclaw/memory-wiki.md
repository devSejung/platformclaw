---
summary: "PlatformClaw Wiki Hub privacy, sharing, access and upgrade behavior"
read_when:
  - Using Personal or Shared Wiki in PlatformClaw
  - Operating Wiki Hub access and source backups
  - Upgrading a deployment with legacy organization knowledge
title: "Memory Wiki rollout"
---

# Wiki Hub

Open **Settings > Memory > Wiki Hub**. Personal and Shared Wikis use the same
catalog, document cards, reader/editor dialog, search and graph. **Memory** remains
the separate durable recall surface; **Dreaming** remains personal consolidation.
Organization directory management stays under **Settings > Organization**.

## Upgrade deletes retired organization knowledge

This company deployment intentionally removes the old Organization Memory
knowledge system. On Control Plane startup, the upgrade deletes its claims,
pages, promotion requests and decisions, comparisons, reports, proposals,
references, revisions, related knowledge audit payloads and stale Managed Wiki
connections. This includes pending proposals; nothing is automatically approved
or migrated into Shared Wikis. The old organization knowledge tools, browser
APIs, analysis jobs and generators are removed.

The cleanup preserves employees, organizations, direct memberships, join
requests, Personal Memory, Personal Wiki, Shared Wiki documents and their grants.
It executes atomically before services start, records a durable completion marker,
and retries after failure. Later startups also remove retired rows reintroduced
by an older image or restored database. A completed marker never allows the old
corpus to become searchable again. Historical schema definitions remain only for
supported database upgrades; the control schema version stays unchanged.

Treat deployment as a destructive knowledge cutover. Existing offline operator
backups are outside this runtime cleanup. Restoring an older company image can
recreate old knowledge; starting this version removes it again.

## Catalog and access

**My Wikis** includes accessible Personal and Shared Wikis, including those with
AI reference disabled. **Find Wikis** searches all Shared names and descriptions.
An authenticated employee can discover a Shared Wiki before receiving access;
its documents, document counts, attachments, snippets and graph stay private.
Personal Wiki is visible only to its bound employee.

| Role   | Capability                                                                              |
| ------ | --------------------------------------------------------------------------------------- |
| Reader | Read and search documents; download individual sources and attachments                  |
| Editor | Reader capabilities plus create, edit, delete, upload, rebuild and complete ZIP export  |
| Owner  | Editor capabilities plus manage user and organization grants and decide access requests |

Owners can grant a role to an employee or an exact Team, Group or Part. An
organization grant applies to **direct members of that selected scope only**.
It does not automatically include ancestors, descendants or sibling scopes.
Overlapping direct-user and organization grants resolve to the highest role.
Current employee status, direct membership and active scope lineage are checked
on each read. Organization leadership alone does not grant Wiki ownership.
The old independent whole-Wiki export permission is retired; effective Editor
or Owner is required for Shared ZIP export.

Choose **Request access** for Reader or Editor. **Requests** shows your outcomes
and pending requests you may decide as Owner. The requester can cancel a pending
request. Approval records the decision and grants access in one transaction;
a second decision fails explicitly. Grants, requests, decisions and owner
recovery have audit records. Recent request lists are bounded to 50 per inbox.

An explicit Wiki grant or member removal cannot remove its last effective Owner.
Employee disablement, organization departure and archival still proceed: they
must not be blocked by Wiki ownership. If these changes leave no active Owner,
an administrator can explicitly assign a replacement Owner from the catalog.
This recovery permission reveals no document content and does not automatically
grant the administrator read access or ownership.

## AI reference and turn context

Access and AI reference are separate. New effective access automatically enables
that Wiki for AI reference. Turning it off preserves read/edit access. Your choice
survives login, refresh, redundant grants and role changes. Losing all access
removes it; genuinely regaining access enables it again. Personal Wiki has its
own AI-reference toggle, enabled initially. This toggle does not disable raw
Personal Memory recall.

Changes apply to the **next agent turn**. The current turn retains its starting
selection, while every actual read still checks live permission. Content already
retrieved into conversation history cannot be removed by toggling a Wiki. Use a
new conversation when that history must be excluded. The bounded internal turn
selection supports up to 256 enabled Shared Wikis.
At that limit, a new grant still provides access, but the catalog records why
automatic AI reference could not be enabled. Disable another Shared Wiki, then
enable the new one explicitly; freeing a slot does not silently change preferences.

## Add and edit knowledge

Use **Add knowledge** to write a document or upload UTF-8 `.md` or `.markdown`.
Shared Wikis also offer a searchable Personal Wiki source picker. Ordinary
Markdown needs no special fields or template. The server previews the title
using a valid YAML string `title`, then the first H1 outside code blocks, then
the filename. Source-less new documents use `Untitled document`.

Paths are assigned automatically without overwriting another document. Shared
Wikis offer an advanced explicit path; an occupied explicit path fails. Personal
Wiki assigns its path through its source owner and shows the actual path after
saving. Shared path moves retain document identity.

Document cards preview the document body for both Personal and Shared Wikis;
source paths and indexing status stay in metadata. While editing, **Insert document
link** searches documents in the current Wiki and inserts the selected full path.
The server requires edit access and returns at most 20 targets per search. A link
does not grant access to another Wiki or automatically publish private content.

Uploads preserve original bytes when their derived title is accepted. Shared
display titles are separate metadata. An explicitly changed Personal title is
an intentional source metadata edit: its title frontmatter changes while other
metadata and body remain intact. This is a user write, never compiler rewriting.
Ordinary edits expose the editable body, preserving existing valid frontmatter.
Source-owned Personal pages expose their notes editor or a read-only explanation.

Cards, graph nodes and search hits open the same document dialog. Closing it
preserves the search query and results, including cross-Wiki hits. Unsaved edits
require confirmation before discard. Delete requires a fresh source revision;
a changed document must be reviewed again. Deletion removes that document, not
its independent published copies or conversation history. Imported Personal
pages retain the existing source-owner deletion and resynchronization policy.

### Explicit Personal publication

From a Personal document, choose **Publish to Shared vault**, choose an editable
Shared Wiki and review the copy. The same source picker is available inside a
Shared Wiki. Publication checks the original Personal source revision again.
It preserves the private original and copies only the explicitly reviewed
Markdown; attachments and linked documents are not silently shared. Later edits
do not synchronize. There is no organization knowledge review/approval workflow.

### Attachments and archives

Personal and Shared Wikis provide attachment upload/download and complete ZIP
export. PDF and Word files remain binary attachments; their text is not extracted
or searched. Add their content as Markdown when it must be searchable.

The ZIP contains `vault.json`, original Markdown under `documents/`, and files
under `attachments/`. It excludes indexes, generated navigation/reports, derived
links and access grants. Personal exports include only safe files inside the
Personal Wiki source root, never linked external source files or host paths.
Reads pin source revisions; changing files abort an inconsistent export.

**Import ZIP as new vault** accepts the PlatformClaw export format and creates a
new Shared Wiki owned by the importer. It rebuilds indexes and links, never
merges or overwrites another Wiki. Arbitrary repository or Obsidian ZIPs are not
accepted as-is. Limits: 1 MiB per Markdown source, 8 MiB per attachment, 999 source
files, 32 MiB ZIP and 64 MiB expanded data. Shared storage reserves capacity at
31 MiB of source data. An over-limit Personal export fails explicitly rather
than silently omitting files; ordinary Personal browsing remains available.

ZIP excludes derived identity links. A link still naming a document's old path
may need manual repair after import; export does not rewrite authored Markdown.

## Search and tools

`memory_search` combines raw Personal Memory with enabled authorized Wiki
sources. `wiki_search` searches Wiki knowledge. Omitting a Wiki target uses the
server-selected enabled scope; an explicit accessible target also works when
AI reference is disabled. Browser search can explicitly include all accessible
Wikis without changing AI-reference settings.

Agents pass a returned `vaultId` or an exact user-provided `vaultName`, never
both. Duplicate names return bounded choices for the user instead of guessing.
The model does not choose file versus database storage or receive a large Wiki
catalog. Results carry `vaultId`, `vaultName`, `vaultType`, `documentId`, `title`,
`path`, `snippet`, an owner-generated insertable `link`, and revision/source version. Display titles and snippets stay
prominent; technical identity and path remain available in expandable details.

Search uses literal keywords, not inferred synonyms. Shared search supports up
to 16 distinct keywords across title, body, path and document identity. Links
are not required for a document to appear. Return paths unchanged to the read
tool. Reads expose the editable body and opaque source revision, up to 200 lines
and 12,000 characters per excerpt, with truncation and continuation metadata.
Never replace a complete document with a partial excerpt. An oversized single
line directs the user to the browser editor instead of looping on the same range.

The existing `wiki_status`, `wiki_lint` and `wiki_apply` tools also dispatch to
the authorized owner. `wiki_apply` uses `create`, `update` or `refresh`; Shared
writes require an explicit destination and updates require the just-read
revision. Status/lint use enabled sources by default, return bounded summaries
and disclose omitted Wikis. No duplicate search tool or backend argument exists.

## Compilation and graph

The index is a derived searchable lookup of original text and accepted source
versions. Compilation builds search chunks/indexes, metadata, authored links,
backlinks and related navigation. It never rewrites user-authored Markdown or
invents source claims. Shared compilation uses no LLM.

For example, `[Training](training.md)` creates an outgoing reference and a
backlink. Both Wikis resolve exact full paths first, then normalized paths
(case-insensitive, optional `.md`), document IDs, and titles. `[[PHY Training]]`
can name a unique title; duplicate titles remain unresolved. The document picker
inserts an escaped full path, including filenames containing spaces or link
delimiters. Relative Markdown paths, reference-style links and heading anchors
resolve within the same Wiki. Code examples do not create links. Missing or
ambiguous links remain visible and
do not prevent search. Documents without links still appear in the graph.

A failed compile preserves the source and last successful search index, records
the error, and schedules a bounded retry. Use **Rebuild search and links** to
retry manually. Shared retries run each minute with bounded exponential backoff;
Personal uses its existing compiler retry owner. Graph data can show the last
accepted Shared revision while the source has changed. Personal graph reads
current sources while search retains the accepted publication.

The common graph supports document selection, filtering, pan, zoom and fitting
the view. Directed links use saved relationships, not inferred similarity;
Personal's existing relationship types remain owned by its compiler. Limits and
truncated results are visible. Source metadata such as claims, questions and
contradictions is available in document details without automatic new inference.

## Runtime ownership

The bundled `memory-wiki` plugin owns Personal sources, source-safe writes,
compilation and attachments. Shared source/derived data, ACL, access requests,
enabled preferences and retirement markers use additive tables in the existing
Control Plane SQLite database. There is no schema-version bump, vector database,
LLM router, private-source auto-publication or VM-local memory mirror.

The deployed `platformclaw-org-memory` plugin identifier remains in managed
configuration to preserve existing installations. It now supplies Wiki Hub
corpus dispatch only; it does not retain organization knowledge producers.
The normal deployment reconciler enables native memory and Wiki policy:

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

The server pins browser operations to the authenticated employee's active
personal Agent. Basic-server and assigned-VM chats use the same knowledge owner.
No new environment variable, external service or per-user backend setting is
required. Existing raw Memory deletion, Dreaming and imported-source ownership
remain separate from Shared publication.
