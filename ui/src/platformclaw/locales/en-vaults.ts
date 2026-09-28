export const vaultTranslations: Readonly<Record<string, string>> = {
  "platformClaw.vault.linksTruncated":
    "Only part of the document links is shown. Links beyond this limit are not available in this reader.",
  "platformClaw.vault.insertLink": "Document link",
  "platformClaw.vault.linkPickerHint":
    "Choose a document from this Wiki. Its link will replace the selected text or be inserted at the cursor.",
  "platformClaw.vault.findLinkDocument": "Search documents in this Wiki",
  "platformClaw.vault.insertLinkAction": "Insert link",
  "platformClaw.vault.noLinkDocuments": "No matching documents in this Wiki.",
  "platformClaw.vault.linkMoreResults": "More documents match. Refine your search.",
  "platformClaw.vault.backToDraft": "Back to draft",

  "platformClaw.vault.connectionCapacity":
    "AI reference could not be enabled because its limit was reached. Turn off another vault, then enable this one.",
  "platformClaw.vault.attachmentsTruncated":
    "Only part of the attachment list is shown. The vault ZIP includes every attachment within the export limits.",
  "platformClaw.vault.recoverOwner": "Assign a new Owner",
  "platformClaw.vault.recoverOwnerHint":
    "This vault has no active Owner. Choose a person to take ownership. Administrative recovery does not give you access to its documents.",
  "platformClaw.vault.confirmOwner": "Confirm new Owner",
  "platformClaw.vault.ownerRecovered": "The new Owner can now manage this vault.",

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
  "platformClaw.vault.catalogHint":
    "Open your personal and shared knowledge. Choose which vaults AI can reference.",
  "platformClaw.vault.mine": "My vaults",
  "platformClaw.vault.discover": "Discover",
  "platformClaw.vault.catalogTabs": "Wiki Hub views",
  "platformClaw.vault.findLabel": "Find vaults",
  "platformClaw.vault.findPlaceholder": "Search vault names or topics",
  "platformClaw.vault.nextTurnHint":
    "AI reference changes apply from the next turn. Information already in this conversation remains.",
  "platformClaw.vault.accessibleHint":
    "All your accessible vaults appear here, including those with AI reference turned off.",
  "platformClaw.vault.personalTitle": "Personal",
  "platformClaw.vault.personalHint":
    "Private knowledge. Publish an explicit copy to share with a Shared vault.",
  "platformClaw.vault.privateLabel": "Only you",
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
  "platformClaw.vault.searchDocuments": "Search document contents",
  "platformClaw.vault.connectedScope": "AI-enabled vaults",
  "memoryPage.memories.searchDescription":
    "Search personal memory and the Personal and Shared vaults in Wiki Hub within the selected scope.",
  "memoryPage.memories.searchPlaceholder": "Search personal memory and Wiki Hub",
  "platformClaw.vault.invalidUtf8":
    "Markdown must be valid UTF-8. Save the original as UTF-8 and upload it again.",
  "platformClaw.vault.secureContext":
    "Publish requires a secure browser connection (HTTPS or localhost). Reopen this page securely and review the source again.",
  "platformClaw.vault.retainedIndex":
    "Search index update failed. Showing the last successful indexed version.",
  "platformClaw.vault.searchUnavailable":
    "Shared vault search is temporarily unavailable. Some results may be missing; try again.",
  "platformClaw.vault.downloadAttachment": "Download attachment",
  "platformClaw.vault.title": "Wiki Hub",
  "platformClaw.vault.intro":
    "Personal is private. Shared brings people and project knowledge together.",
  "platformClaw.vault.private":
    "Personal content stays private until you explicitly publish a copy.",
  "platformClaw.vault.shared": "Shared",
  "platformClaw.vault.typePersonal": "Personal",
  "platformClaw.vault.new": "Create Shared vault",
  "platformClaw.vault.name": "Vault name",
  "platformClaw.vault.description": "Description",
  "platformClaw.vault.create": "Create vault",
  "platformClaw.vault.select": "Open vault",
  "platformClaw.vault.choose": "Choose a Shared vault",
  "platformClaw.vault.empty": "No Shared vaults yet. Create one or ask an Owner to add you.",
  "platformClaw.vault.unavailable":
    "Wiki Hub is unavailable. Connect to a gateway with Wiki Hub support.",
  "platformClaw.vault.loading": "Loading vault…",
  "platformClaw.vault.refresh": "Refresh",
  "platformClaw.vault.import": "Import ZIP as new vault",
  "platformClaw.vault.importHint":
    "Choose a PlatformClaw vault export ZIP, not a general document archive. This creates a new Shared vault without merging. Members are not invited automatically; search and links are rebuilt.",
  "platformClaw.vault.export": "Download entire vault ZIP",
  "platformClaw.vault.exportHint":
    "Editor and Owner can download documents, attachments and the entire vault.",
  "platformClaw.vault.documents": "Documents",
  "platformClaw.vault.noDocuments":
    "No documents yet. Use Add knowledge to write, choose Personal knowledge, or import Markdown.",
  "platformClaw.vault.newDocument": "Write document",
  "platformClaw.vault.uploadMarkdown": "Upload Markdown",
  "platformClaw.vault.path": "Document path",
  "platformClaw.vault.documentTitle": "Document title",
  "platformClaw.vault.body": "Markdown content",
  "platformClaw.vault.save": "Save document",
  "platformClaw.vault.cancel": "Cancel",
  "platformClaw.vault.edit": "Edit document",
  "platformClaw.vault.download": "Download Markdown",
  "platformClaw.vault.saved": "Document saved. Search and link status is shown with the document.",
  "platformClaw.vault.members": "Members and permissions",
  "platformClaw.vault.account": "Employee account ID",
  "platformClaw.vault.role": "Role",
  "platformClaw.vault.reader": "Reader",
  "platformClaw.vault.editor": "Editor",
  "platformClaw.vault.owner": "Owner",
  "platformClaw.vault.setMember": "Add or change access",
  "platformClaw.vault.removeMember": "Remove grant",
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
  "platformClaw.vault.publish": "Publish to Shared vault",
  "platformClaw.vault.sourcePath": "Personal source path",
  "platformClaw.vault.previewSource": "Review source",
  "platformClaw.vault.publishConfirm": "Publish shared copy",
  "platformClaw.vault.publishHint":
    "Review the copy that vault members will see. Your Personal original remains private and unchanged. Later edits are independent; copies do not sync.",
  "platformClaw.vault.published": "Published a copy. Personal original unchanged.",
  "platformClaw.vault.searchScope": "Search scope",
  "platformClaw.vault.allVaults": "All accessible vaults",
  "platformClaw.vault.searchThisVault": "Only this vault",
  "platformClaw.vault.operationDone": "Done. Showing latest vault state.",
  "platformClaw.vault.tooLarge": "File exceeds the upload limit.",
  "platformClaw.vault.sourceUnavailable":
    "This source cannot be published. Choose a complete, revisioned Personal document.",
  "platformClaw.vault.close": "Close document",
  "platformClaw.vault.addKnowledge": "Add knowledge",
  "platformClaw.vault.personalSource": "From Personal",
  "platformClaw.vault.chooseMarkdown": "Choose Markdown file",
  "platformClaw.vault.markdownHint":
    "Import one UTF-8 .md or .markdown file (up to 1 MB). Review and edit before saving.",
  "platformClaw.vault.automaticTitle": "Detect from Markdown or filename",
  "platformClaw.vault.writeCopy": "Edit content",
  "platformClaw.vault.previewCopy": "Review document",
  "platformClaw.vault.advancedPath": "Advanced: document path",
  "platformClaw.vault.automaticPath": "Created automatically",
  "platformClaw.vault.automaticPathHint":
    "Leave blank to create a unique path automatically. Set a path only when organizing or moving documents.",
  "platformClaw.vault.noEditableVault":
    "No editable Shared vaults. Create one in Wiki Hub or request Editor access.",
  "platformClaw.vault.linkReviewHint":
    "Links resolve within the destination vault after saving. Missing targets are shown in the document; text is still searchable.",
  "platformClaw.vault.attachmentHint":
    "Attachments, including PDF files, are for download only. Their contents are not included in search or the graph. Add Markdown to make knowledge searchable.",
  "platformClaw.vault.readerEmpty":
    "No documents yet. An Editor or Owner can add knowledge to this vault.",
  "platformClaw.vault.unresolvedNotice":
    "Some links have no matching document in this vault. Review document links below. The document remains searchable.",
  "platformClaw.vault.relationships": "Document links and backlinks",
  "platformClaw.vault.documentDetails": "Document details",
  "platformClaw.vault.discardTitle": "Discard unsaved changes?",
  "platformClaw.vault.discardDescription":
    "Your edits have not been saved. Keep editing, or discard them to continue.",
  "platformClaw.vault.keepEditing": "Keep editing",
  "platformClaw.vault.discard": "Discard changes",
  "platformClaw.vault.changeSource": "Choose another Personal document",
  "platformClaw.vault.viewPublished": "Open shared copy",
  "platformClaw.vault.searchWithinVault": "Search this vault’s document contents",
  "platformClaw.vault.selectedPersonalSource": "Personal source",
  "platformClaw.vault.requests": "Requests",
  "platformClaw.vault.personal": "Personal",
  "platformClaw.vault.aiReference": "AI reference",
  "platformClaw.vault.noAccess": "Access required",
  "platformClaw.vault.accessRequired": "Request Reader or Editor access to open documents.",
  "platformClaw.vault.requestAccess": "Request access",
  "platformClaw.vault.requestPending": "Request pending",
  "platformClaw.vault.requestHint":
    "The vault Owner reviews your request. Approval grants access and enables AI reference.",
  "platformClaw.vault.requestReason": "Reason (optional)",
  "platformClaw.vault.sendRequest": "Send request",
  "platformClaw.vault.requestSent": "Request sent. Track the result in Requests.",
  "platformClaw.vault.myRequest": "Your request",
  "platformClaw.vault.myRequests": "My requests",
  "platformClaw.vault.pendingApprovals": "Requests to review",
  "platformClaw.vault.noPendingApprovals": "No requests awaiting your approval.",
  "platformClaw.vault.noRequests": "No access requests yet.",
  "platformClaw.vault.approve": "Approve",
  "platformClaw.vault.reject": "Reject",
  "platformClaw.vault.cancelRequest": "Cancel request",
  "platformClaw.vault.requestStatus.pending": "Pending",
  "platformClaw.vault.requestStatus.approved": "Approved",
  "platformClaw.vault.requestStatus.rejected": "Rejected",
  "platformClaw.vault.requestStatus.cancelled": "Cancelled",
  "platformClaw.vault.grantHint":
    "Access can come from a person or organization grant. The highest role applies. Editor and Owner can export; new grants enable AI reference automatically.",
  "platformClaw.vault.directMembers": "People",
  "platformClaw.vault.organizationGrants": "Organization grants",
  "platformClaw.vault.noOrganizationGrants": "No organization grants.",
  "platformClaw.vault.grantTarget": "Grant to",
  "platformClaw.vault.person": "Person",
  "platformClaw.vault.organization": "Organization",
  "platformClaw.vault.searchPeople": "Search name or account",
  "platformClaw.vault.searchOrganizations": "Search organization name",
  "platformClaw.vault.searchTargets": "Search",
  "platformClaw.vault.targetsHasMore": "More matches available. Refine your search.",
  "platformClaw.vault.grantAccess": "Grant selected role",
  "platformClaw.vault.claims": "Claims",
  "platformClaw.vault.questions": "Open questions",
  "platformClaw.vault.contradictions": "Contradictions",
  "platformClaw.vault.discoverHint":
    "Browse Shared vaults. Request access when you are not a member.",
  "platformClaw.vault.deleteDocument": "Delete document",
  "platformClaw.vault.deleteDocumentHint":
    "Delete this document from its vault. Other documents and published copies remain.",
  "platformClaw.vault.documentDeleted": "Document deleted. Search and links will refresh.",
};
