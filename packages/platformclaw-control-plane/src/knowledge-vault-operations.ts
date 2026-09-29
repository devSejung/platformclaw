import { ControlPlaneStateError } from "./contracts.js";
import type { KnowledgeVaultTurnScope } from "./knowledge-vault-contracts.js";
import type { KnowledgeVaultService } from "./knowledge-vault-service.js";

export type KnowledgeVaultWikiOperation = {
  agentId: string;
  vaultId?: string;
  vaultName?: string;
  turnScope?: KnowledgeVaultTurnScope;
  operation: "status" | "lint" | "apply";
  mutation?: {
    op: "create" | "update" | "refresh";
    title?: string;
    body?: string;
    lookup?: string;
    expectedRevision?: string;
  };
};

export function operateSharedWiki(
  service: KnowledgeVaultService,
  params: KnowledgeVaultWikiOperation,
) {
  const store = service.store.vaults;
  const userId = store.userIdForAgent(params.agentId);
  const vaultId = service.resolveSharedTarget(userId, params.vaultId, params.vaultName);
  if (params.operation === "apply") {
    if (!vaultId) {
      throw new ControlPlaneStateError("Choose the destination Wiki explicitly before writing");
    }
    const mutation = params.mutation;
    if (!mutation || !["create", "update", "refresh"].includes(mutation.op)) {
      throw new ControlPlaneStateError("Choose create, update or refresh");
    }
    if (mutation.op === "refresh") {
      const snapshot = store.rebuild({ userId, vaultId });
      const failed =
        snapshot.selected?.documents.filter((document) => document.compile.status === "failed")
          .length ?? 0;
      return {
        text: failed
          ? `Rebuild finished with ${failed} failed documents. Read status for retry details.`
          : "Wiki search and links rebuilt.",
        details: { vaultId, failed },
      };
    }
    if (typeof mutation.body !== "string" || Buffer.byteLength(mutation.body) > 256 * 1024) {
      throw new ControlPlaneStateError("The complete Markdown body must fit within 256 KiB");
    }
    let documentId: string | undefined;
    let expectedRevision: number | undefined;
    if (mutation.op === "update") {
      if (
        !mutation.lookup ||
        !mutation.expectedRevision ||
        !/^[1-9][0-9]*$/u.test(mutation.expectedRevision)
      ) {
        throw new ControlPlaneStateError(
          "Read the document first, then provide its lookup and expectedRevision",
        );
      }
      expectedRevision = Number(mutation.expectedRevision);
      if (!Number.isSafeInteger(expectedRevision)) {
        throw new ControlPlaneStateError("Invalid expectedRevision");
      }
      const documents = store.snapshot({ userId, vaultId }).selected!.documents;
      documentId = documents.find((document) =>
        [document.id, document.logicalPath, `shared/${vaultId}/${document.id}`].includes(
          mutation.lookup!,
        ),
      )?.id;
      if (!documentId) {
        throw new ControlPlaneStateError("Document lookup was not found in the selected Wiki");
      }
    }
    const document = store.saveDocument({
      userId,
      vaultId,
      documentId,
      expectedRevision,
      title: mutation.title,
      content: mutation.body,
    });
    return {
      text: `Saved ${document.title}. Search state: ${document.compile.status}.`,
      details: {
        vaultId,
        documentId: document.id,
        title: document.title,
        path: `shared/${vaultId}/${document.id}`,
        revision: String(document.revision),
        compile: document.compile,
      },
    };
  }
  const enabled = new Set((params.turnScope ?? store.connectionScope(userId)).vaultIds);
  const selected = store
    .listVaults(userId)
    .filter((vault) => vault.canRead && (vaultId ? vault.id === vaultId : enabled.has(vault.id)));
  if (vaultId && !selected.length) {
    store.snapshot({ userId, vaultId });
  }
  // A bounded corpus summary avoids injecting a catalog that the model must guess from.
  const summaries = selected.slice(0, 10).map((vault) => {
    const snapshot = store.snapshot({ userId, vaultId: vault.id }).selected!;
    const failed = snapshot.documents.filter((document) => document.compile.status === "failed");
    return {
      vaultId: vault.id,
      vaultName: vault.name,
      documents: snapshot.documents.length,
      failed: failed.length,
      pending: snapshot.documents.filter((document) => document.compile.status === "pending")
        .length,
      unresolvedLinks: snapshot.graph.unresolvedLinks,
    };
  });
  return {
    text: selected.length
      ? `${params.operation === "lint" ? "Link and index checks" : "Wiki status"}: ${summaries.map((item) => `${item.vaultName}: ${item.documents} documents, ${item.failed} failed, ${item.unresolvedLinks} unresolved links`).join("; ")}`.slice(
          0,
          4000,
        )
      : "No enabled accessible Shared Wikis. Enable one in Wiki Hub or provide an explicit accessible target.",
    details: {
      wikis: summaries,
      totalWikis: selected.length,
      truncated: selected.length > summaries.length,
    },
  };
}
