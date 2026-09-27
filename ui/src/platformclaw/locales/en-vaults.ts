export const vaultTranslations: Readonly<Record<string, string>> = {
  "platformClaw.vault.documentViews": "Document views",
  "platformClaw.vault.graph": "Document graph",
  "platformClaw.vault.graphHint":
    "Arrows follow links written in documents. All documents appear, including those without links. Search works independently of links.",
  "platformClaw.vault.graphEmpty": "No documents yet. Add a document to see it in the graph.",
  "platformClaw.vault.graphSearch": "Filter graph by title or path",
  "platformClaw.vault.graphSelect": "Select a document",
  "platformClaw.vault.graphSelectHint":
    "Select a node to inspect its incoming and outgoing links, then open the document.",
  "platformClaw.vault.graphOpen": "Open document",
  "platformClaw.vault.graphControls": "Graph view controls",
  "platformClaw.vault.graphZoomIn": "Zoom in",
  "platformClaw.vault.graphZoomOut": "Zoom out",
  "platformClaw.vault.graphReset": "Reset view",
  "platformClaw.vault.graphFit": "Fit graph",
  "platformClaw.vault.graphCounts": "{nodes} documents · {edges} visible links",
  "platformClaw.vault.graphUnresolved": "{count} unresolved links",
  "platformClaw.vault.graphTruncated":
    "Some links are omitted from this view. A document without visible edges may still have links; open it to inspect all relationships.",
  "platformClaw.vault.graphNoMatches":
    "No matching documents. Clear the filter to see all documents.",
  "platformClaw.vault.graphNoLinks": "No links in this direction.",
  "platformClaw.vault.graphNoVisibleLinks":
    "No links shown in this direction. Some links may be omitted.",
  "platformClaw.vault.graphRetained":
    "Some document links are not up to date. Inspect a document for its saved search version and retry status.",
  "platformClaw.vault.indexDefinition":
    "Search indexes are derived data used to find documents; rebuilding also updates links.",
  "platformClaw.vault.indexPreserved":
    "The original document is safe. The last successful search data and links remain available.",
  "platformClaw.vault.indexMissing":
    "The original document is safe. No search data or links have been generated yet; open the original to read it.",
  "platformClaw.vault.indexDetails": "Search version and retry details",
  "platformClaw.vault.indexRetry":
    "Automatic retries are scheduled. An Editor or Owner can also rebuild search and links.",
  "platformClaw.vault.namePlaceholder": "Project or topic",

  "platformClaw.vault.createHint":
    "You become Owner. This new vault is connected for your next turn.",
  "platformClaw.vault.createdNotice":
    "Created and connected. Add documents or invite members to begin.",
  "platformClaw.vault.exportAllowed": "Entire-vault download allowed",
  "platformClaw.vault.exportNotAllowed": "Entire-vault download not allowed",
  "platformClaw.vault.catalogHint":
    "Connect project knowledge for your AI to reference. Manage documents and access here.",
  "platformClaw.vault.mine": "My vaults",
  "platformClaw.vault.discover": "Find vaults",
  "platformClaw.vault.catalogTabs": "Memory Hub views",
  "platformClaw.vault.findLabel": "Find an accessible vault",
  "platformClaw.vault.findPlaceholder": "Search vault names or topics",
  "platformClaw.vault.nextTurnHint":
    "Connections apply from your next turn. Information already in this conversation remains.",
  "platformClaw.vault.accessibleHint":
    "Only vaults you can access are shown. Adding a vault keeps its documents in their original location.",
  "platformClaw.vault.alwaysOn": "Always available",
  "platformClaw.vault.personalTitle": "My personal knowledge",
  "platformClaw.vault.personalHint":
    "Your memory and Personal Wiki remain private. Sharing requires publishing a copy.",
  "platformClaw.vault.privateLabel": "Only you",
  "platformClaw.vault.openPersonal": "Open Personal Wiki",
  "platformClaw.vault.aiOn": "AI reference enabled",
  "platformClaw.vault.notConnected": "Not connected",
  "platformClaw.vault.sharedHint": "Project knowledge shared with vault members.",
  "platformClaw.vault.documentCount": "{count} documents",
  "platformClaw.vault.view": "Open vault",
  "platformClaw.vault.connect": "Add to my vaults",
  "platformClaw.vault.disconnect": "Disconnect",
  "platformClaw.vault.noMatches": "No matching vaults. Try another name or topic.",
  "platformClaw.vault.noConnected":
    "Add a project vault to make its knowledge available to your AI.",
  "platformClaw.vault.backToVaults": "Back to my vaults",
  "platformClaw.vault.connectedNotice":
    "Connected. Your AI can reference this vault from your next turn.",
  "platformClaw.vault.disconnectedNotice":
    "Disconnected for your next turn. Original documents, access permissions, and existing conversation content are unchanged.",
  "platformClaw.vault.importedNotice":
    "Imported and connected as a new vault. Your AI can reference it from your next turn.",
  "platformClaw.vault.chooseZip": "Choose ZIP file",
  "platformClaw.vault.closeDialog": "Close dialog",
  "platformClaw.vault.managedTitle": "Organization knowledge",
  "platformClaw.vault.openManaged": "Open Organization Memory",
  "platformClaw.vault.searchDocuments": "Search document contents",
  "platformClaw.vault.connectedScope": "Personal + connected vaults",
  "memoryPage.memories.searchDescription":
    "Search Personal memory and Wiki, Shared project vaults, and Managed knowledge within the selected scope.",
  "memoryPage.memories.searchPlaceholder": "Search Personal, Shared, and Managed knowledge",
  "platformClaw.vault.invalidUtf8":
    "Markdown must be valid UTF-8. Save the original as UTF-8 and upload it again.",
  "platformClaw.vault.secureContext":
    "Publish requires a secure browser connection (HTTPS or localhost). Reopen this page securely and review the source again.",
  "platformClaw.vault.retainedIndex":
    "Search index update failed. Showing the last successful indexed version.",
  "platformClaw.vault.searchUnavailable":
    "Shared and Managed vault search is temporarily unavailable. Results may be incomplete; retry the search.",
  "platformClaw.vault.downloadAttachment": "Download attachment",
  "platformClaw.vault.title": "Memory Hub",
  "platformClaw.vault.intro":
    "Personal is private. Shared is for project members. Managed follows organization permissions.",
  "platformClaw.vault.private":
    "Personal content stays private until you explicitly publish a copy.",
  "platformClaw.vault.managed":
    "Managed knowledge continues in Organization Memory with its existing approval and access rules.",
  "platformClaw.vault.shared": "Shared",
  "platformClaw.vault.new": "Create Shared vault",
  "platformClaw.vault.name": "Vault name",
  "platformClaw.vault.description": "Description",
  "platformClaw.vault.create": "Create vault",
  "platformClaw.vault.select": "Open vault",
  "platformClaw.vault.choose": "Choose a Shared vault",
  "platformClaw.vault.empty": "No Shared vaults yet. Create one or ask an Owner to add you.",
  "platformClaw.vault.unavailable":
    "Memory Hub is unavailable. Connect to a gateway that supports vaults.",
  "platformClaw.vault.loading": "Loading vault…",
  "platformClaw.vault.refresh": "Refresh",
  "platformClaw.vault.import": "Import ZIP as new vault",
  "platformClaw.vault.importHint":
    "Import creates a new Shared vault. Existing vaults are never merged. Members are not automatically invited; indexes are rebuilt.",
  "platformClaw.vault.export": "Download entire vault ZIP",
  "platformClaw.vault.exportHint":
    "Entire-vault download requires its own permission, separate from reading documents.",
  "platformClaw.vault.documents": "Documents",
  "platformClaw.vault.noDocuments":
    "No documents yet. Add Markdown or publish a Personal Wiki copy.",
  "platformClaw.vault.newDocument": "Write document",
  "platformClaw.vault.uploadMarkdown": "Upload Markdown",
  "platformClaw.vault.path": "Document path",
  "platformClaw.vault.documentTitle": "Document title",
  "platformClaw.vault.body": "Original Markdown",
  "platformClaw.vault.save": "Save original",
  "platformClaw.vault.cancel": "Cancel",
  "platformClaw.vault.edit": "Edit / move",
  "platformClaw.vault.download": "Download Markdown",
  "platformClaw.vault.saved":
    "Saved. Original content is preserved; search index status appears below.",
  "platformClaw.vault.members": "Members and permissions",
  "platformClaw.vault.account": "Employee account ID",
  "platformClaw.vault.role": "Role",
  "platformClaw.vault.reader": "Reader · read",
  "platformClaw.vault.editor": "Editor · read and edit",
  "platformClaw.vault.owner": "Owner · manage vault",
  "platformClaw.vault.allowExport": "Allow entire-vault download",
  "platformClaw.vault.setMember": "Save member permissions",
  "platformClaw.vault.removeMember": "Remove member",
  "platformClaw.vault.attachments": "Attachments",
  "platformClaw.vault.uploadAttachment": "Upload attachment",
  "platformClaw.vault.rebuild": "Rebuild search and links",
  "platformClaw.vault.pending": "Updating search and links",
  "platformClaw.vault.ready": "Search ready",
  "platformClaw.vault.failed": "Search and link update failed",
  "platformClaw.vault.indexHint":
    "The original document is safe. Only search data and document links could not be generated. The last successful index remains available; automatic retries or Rebuild can recover it.",
  "platformClaw.vault.indexedRevision": "Indexed revision",
  "platformClaw.vault.retryAt": "Next retry",
  "platformClaw.vault.links": "Links",
  "platformClaw.vault.backlinks": "Backlinks / affected documents",
  "platformClaw.vault.publish": "Publish Personal Wiki copy",
  "platformClaw.vault.sourcePath": "Personal Wiki source path",
  "platformClaw.vault.previewSource": "Review source",
  "platformClaw.vault.publishConfirm": "Publish reviewed copy to this Shared vault",
  "platformClaw.vault.publishHint":
    "Only the reviewed document is copied. Your Personal original remains private and unchanged.",
  "platformClaw.vault.published": "Published a copy. Personal original unchanged.",
  "platformClaw.vault.searchScope": "Search scope",
  "platformClaw.vault.allVaults": "All accessible vaults",
  "platformClaw.vault.searchThisVault": "Only this vault",
  "platformClaw.vault.operationDone": "Done. Showing latest vault state.",
  "platformClaw.vault.tooLarge": "File exceeds the upload limit.",
  "platformClaw.vault.sourceUnavailable":
    "This source cannot be published. Choose a complete, revisioned Personal Wiki document.",
  "platformClaw.vault.close": "Close document",
};
