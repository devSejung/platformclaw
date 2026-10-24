import { PlatformClawVaultDocumentBulkDelete } from "./memory-vault-document-bulk-delete.ts";

if (!customElements.get("platformclaw-vault-document-bulk-delete")) {
  customElements.define(
    "platformclaw-vault-document-bulk-delete",
    PlatformClawVaultDocumentBulkDelete,
  );
}
