/** Browser-only management operations; these are not agent tools. */
export const KNOWLEDGE_VAULT_RPC_PARAMS = {
  "platformclaw.vault.snapshot": ["vaultId"],
  "platformclaw.vault.connection.set": ["vaultId", "connected"],
  "platformclaw.vault.create": ["name", "description"],
  "platformclaw.vault.document.get": ["vaultId", "documentId"],
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
  "platformclaw.vault.member.set": ["vaultId", "accountId", "role", "canExport"],
  "platformclaw.vault.member.remove": ["vaultId", "userId"],
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
