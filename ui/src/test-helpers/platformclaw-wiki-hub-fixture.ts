import type {
  KnowledgeVault,
  KnowledgeVaultDocument,
  KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";

const stamp = Date.UTC(2026, 8, 29, 1);
export const wikiHubPersonalId = "personal:assigned-personal";
export const wikiHubMethods = [
  "snapshot",
  "connection.set",
  "create",
  "rename",
  "delete",
  "document.get",
  "document.save",
  "document.delete",
  "document.preview",
  "document.targets",
  "publish",
  "rebuild",
  "member.set",
  "member.remove",
  "grant.set",
  "grant.remove",
  "targets.search",
  "access.request",
  "access.cancel",
  "access.decide",
  "owner.recover",
].map((name) => `platformclaw.vault.${name}`);
const compile = {
  status: "ready" as const,
  indexedRevision: 1,
  error: null,
  attempts: 0,
  retryAt: null,
};
export const wikiHubPersonalDocument: KnowledgeVaultDocument = {
  id: "syntheses/release-preflight.md",
  vaultId: wikiHubPersonalId,
  title: "Release preflight synthesis",
  snippet: "Record canary health and the responsible owner.",
  logicalPath: "syntheses/release-preflight.md",
  revision: "a".repeat(64),
  updatedAt: stamp,
  content:
    "# Release preflight synthesis\n\nRecord canary health and the responsible owner.\n\nSee [Release ownership](../concepts/release-ownership.md).",
  editableContent:
    "# Release preflight synthesis\n\nRecord canary health and the responsible owner.",
  sourceContent:
    "---\ntitle: Release preflight synthesis\n---\n# Release preflight synthesis\n\nRecord canary health and the responsible owner.",
  editMode: "body",
  metadata: {
    claims: ["Record canary health and its owner."],
    questions: ["Should each canary require an owner checkpoint?"],
    contradictions: [],
  },
  links: [
    {
      target: "concepts/release-ownership.md",
      documentId: "concepts/release-ownership.md",
      logicalPath: "concepts/release-ownership.md",
      title: "Release ownership",
    },
  ],
  backlinks: [],
  compile: { ...compile, indexedRevision: "a".repeat(64) },
};
export const wikiHubSharedDocument: KnowledgeVaultDocument = {
  id: "doc-training",
  vaultId: "vault-phy",
  title: "Training sequence",
  snippet: "Initialize the controller. Verify the training result.",
  logicalPath: "guides/training.md",
  revision: 3,
  updatedAt: stamp,
  content:
    "# Training sequence\n\n1. Initialize the controller.\n2. Verify the training result.\n\nSee [Initialization](init.md).",
  links: [
    {
      target: "guides/init.md",
      documentId: "doc-init",
      logicalPath: "guides/init.md",
      title: "Initialization",
    },
  ],
  backlinks: [],
  compile: { ...compile, indexedRevision: 3 },
};
function vault(
  id: string,
  name: string,
  type: "personal" | "shared",
  role: "reader" | "editor" | "owner",
): KnowledgeVault {
  return {
    id,
    name,
    type,
    description:
      type === "personal"
        ? "Private notes and reusable knowledge."
        : "Project specifications and reviewed training notes.",
    role,
    canRead: true,
    canEdit: role !== "reader",
    canManageMembers: type === "shared" && role === "owner",
    canExport: role !== "reader",
    createdAt: stamp,
    updatedAt: stamp,
  };
}
export function wikiHubSnapshot(
  options: {
    selectedId?: string;
    owner?: boolean;
    enabled?: boolean;
    accessGranted?: boolean;
    pending?: boolean;
  } = {},
): KnowledgeVaultSnapshot {
  const owner = options.owner ?? true;
  const personal = vault(wikiHubPersonalId, "Personal", "personal", "owner");
  const shared = vault("vault-phy", "Ulysses PHY Spec", "shared", owner ? "owner" : "reader");
  const dram = vault("vault-dram", "DRAM Controller", "shared", "editor");
  const inaccessible = vault("vault-lpddr", "LPDDR Training", "shared", "reader");
  const vaults = [
    { ...personal, connected: true, documentCount: 2, attachmentCount: 0 },
    { ...shared, connected: options.enabled ?? true, documentCount: 2, attachmentCount: 1 },
    { ...dram, connected: false, documentCount: 1, attachmentCount: 0 },
    options.accessGranted
      ? { ...inaccessible, connected: true, documentCount: 1, attachmentCount: 0 }
      : {
          ...inaccessible,
          role: null,
          canRead: false,
          canEdit: false,
          canExport: false,
          connected: false,
        },
  ];
  const selectedVault = vaults.find((item) => item.id === options.selectedId && item.canRead);
  const documents =
    selectedVault?.type === "personal"
      ? [
          wikiHubPersonalDocument,
          {
            ...wikiHubPersonalDocument,
            id: "concepts/release-ownership.md",
            logicalPath: "concepts/release-ownership.md",
            title: "Release ownership",
            snippet: "Every production rollout names one owner.",
            content: "# Release ownership\nEvery production rollout names one owner.",
            links: [],
            backlinks: [
              {
                target: wikiHubPersonalDocument.logicalPath,
                documentId: wikiHubPersonalDocument.id,
                logicalPath: wikiHubPersonalDocument.logicalPath,
                title: wikiHubPersonalDocument.title,
              },
            ],
          },
        ]
      : [
          wikiHubSharedDocument,
          {
            ...wikiHubSharedDocument,
            id: "doc-init",
            logicalPath: "guides/init.md",
            title: "Initialization",
            snippet: "Initialize before training.",
            content: "# Initialization\nInitialize before training.",
            links: [],
            backlinks: [],
          },
        ];
  return {
    selectionRevision: 1,
    vaults,
    ownRequests: options.pending
      ? [
          {
            id: "request-own",
            vaultId: "vault-lpddr",
            vaultName: "LPDDR Training",
            userId: "user-me",
            accountId: "member.one",
            displayName: "Member One",
            role: "reader",
            reason: "Preparing the training review",
            status: "pending",
            createdAt: stamp,
          },
        ]
      : [],
    pendingRequests: owner
      ? [
          {
            id: "request-review",
            vaultId: shared.id,
            vaultName: shared.name,
            userId: "user-two",
            accountId: "engineer.two",
            displayName: "Engineer Two",
            role: "editor",
            reason: "Maintaining PHY training specifications",
            status: "pending",
            createdAt: stamp,
          },
        ]
      : [],
    ...(selectedVault && selectedVault.role
      ? {
          selected: {
            vault: { ...selectedVault, role: selectedVault.role },
            documents,
            members:
              selectedVault.type === "shared"
                ? [
                    {
                      userId: "user-me",
                      accountId: "member.one",
                      displayName: "Member One",
                      role: owner ? "owner" : "reader",
                    },
                  ]
                : [],
            grants:
              selectedVault.type === "shared"
                ? [
                    {
                      scopeId: "team-platform",
                      scopeName: "Platform / PHY",
                      scopeKind: "team",
                      role: "reader",
                    },
                  ]
                : [],
            attachments:
              selectedVault.type === "shared"
                ? [
                    {
                      path: "captures/training-result.pdf",
                      mediaType: "application/pdf",
                      bytes: 245_760,
                      revision: 2,
                    },
                  ]
                : [],
            graph: {
              edges: [{ source: documents[0]!.id, target: documents[1]!.id }],
              unresolvedLinks: 0,
              truncated: false,
            },
          },
        }
      : {}),
  };
}
export const wikiHubResponses = {
  "platformclaw.vault.snapshot": {
    cases: [
      ...([wikiHubPersonalId, "vault-phy", "vault-dram"] as const).map((selectedId) => ({
        match: { vaultId: selectedId },
        response: wikiHubSnapshot({ selectedId }),
      })),
      { match: {}, response: wikiHubSnapshot() },
    ],
  },
  "platformclaw.vault.connection.set": {
    cases: [
      { match: { connected: false }, response: wikiHubSnapshot({ enabled: false }) },
      { match: {}, response: wikiHubSnapshot() },
    ],
  },
  "platformclaw.vault.rename": vault("vault-phy", "Renamed PHY Spec", "shared", "owner"),
  "platformclaw.vault.delete": { deleted: true, vaultId: "vault-phy" },
  "platformclaw.vault.document.get": {
    cases: [
      {
        match: { vaultId: wikiHubPersonalId, documentId: "concepts/release-ownership.md" },
        response: wikiHubSnapshot({ selectedId: wikiHubPersonalId }).selected!.documents[1],
      },
      { match: { vaultId: wikiHubPersonalId }, response: wikiHubPersonalDocument },
      { match: {}, response: wikiHubSharedDocument },
    ],
  },
  "platformclaw.vault.document.preview": { title: "Imported document", logicalPath: "imported.md" },
  "platformclaw.vault.document.save": wikiHubSharedDocument,
  "platformclaw.vault.publish": wikiHubSharedDocument,
  "platformclaw.vault.targets.search": {
    cases: [
      {
        match: { kind: "organization" },
        response: {
          items: [{ id: "team-platform", label: "Platform / PHY", detail: "Team" }],
          hasMore: false,
        },
      },
      {
        match: {},
        response: {
          items: [
            {
              id: "user-two",
              accountId: "engineer.two",
              label: "Engineer Two",
              detail: "engineer.two",
            },
          ],
          hasMore: false,
        },
      },
    ],
  },
  "platformclaw.vault.access.request": { id: "request-own", status: "pending" },
  "platformclaw.vault.access.cancel": {},
  "platformclaw.vault.access.decide": {},
  "platformclaw.vault.member.set": {},
  "platformclaw.vault.member.remove": {},
  "platformclaw.vault.grant.set": {},
  "platformclaw.vault.grant.remove": {},
  "platformclaw.vault.rebuild": {},
};
