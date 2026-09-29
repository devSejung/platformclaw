/** Browser-only management operations; these are not agent tools. */
export const KNOWLEDGE_VAULT_RPC_PARAMS = {
  "platformclaw.vault.snapshot": ["vaultId"],
  "platformclaw.vault.connection.set": ["vaultId", "connected"],
  "platformclaw.vault.create": ["name", "description"],
  "platformclaw.vault.document.delete": ["vaultId", "documentId", "expectedRevision"],
  "platformclaw.vault.document.get": ["vaultId", "documentId"],
  "platformclaw.vault.document.targets": ["vaultId", "query"],
  "platformclaw.vault.document.preview": ["vaultId", "content", "filename", "title", "logicalPath"],
  "platformclaw.vault.document.save": [
    "vaultId",
    "documentId",
    "title",
    "logicalPath",
    "content",
    "expectedRevision",
    "filename",
  ],
  "platformclaw.vault.member.set": ["vaultId", "accountId", "role"],
  "platformclaw.vault.member.remove": ["vaultId", "userId"],
  "platformclaw.vault.targets.search": ["vaultId", "kind", "query"],
  "platformclaw.vault.owner.recover": ["vaultId", "accountId"],
  "platformclaw.vault.grant.set": ["vaultId", "scopeId", "role"],
  "platformclaw.vault.grant.remove": ["vaultId", "scopeId"],
  "platformclaw.vault.access.request": ["vaultId", "role", "reason"],
  "platformclaw.vault.access.cancel": ["requestId"],
  "platformclaw.vault.access.decide": ["requestId", "decision"],
  "platformclaw.vault.rebuild": ["vaultId", "documentId"],
  "platformclaw.vault.publish": [
    "lookup",
    "targetVaultId",
    "path",
    "expectedRevision",
    "title",
    "content",
  ],
} as const;

export const KNOWLEDGE_VAULT_RPC_METHODS = Object.keys(KNOWLEDGE_VAULT_RPC_PARAMS) as Array<
  keyof typeof KNOWLEDGE_VAULT_RPC_PARAMS
>;

export function isKnowledgeVaultRpc(method: string): boolean {
  return Object.hasOwn(KNOWLEDGE_VAULT_RPC_PARAMS, method);
}
