import { describe, expect, it } from "vitest";
import { projectWikiDocumentResult } from "./browser-gateway-wiki-document.js";

const source = {
  path: "reports/authored.md",
  title: "Authored",
  kind: "report",
  displayContent: "# Authored",
  sourceContent: "# Authored",
  editMode: null,
  readOnlyReason: "generated-report",
  revision: "a".repeat(64),
  links: [],
  linksTruncated: false,
};
function project(result: unknown) {
  return projectWikiDocumentResult({
    method: "wiki.document.get",
    request: { agentId: "personal-a", lookup: source.path },
    result,
    agentId: "personal-a",
    fail: (message) => {
      throw new Error(message);
    },
  });
}
describe("Wiki document deletion capability projection", () => {
  it.each([true, false])(
    "retains explicit canDelete=%s independently of editability",
    (canDelete) => {
      expect(project({ ...source, canDelete })).toMatchObject({ canDelete, editMode: null });
    },
  );
  it("rejects malformed capabilities and does not invent an absent capability", () => {
    expect(() => project({ ...source, canDelete: "true" })).toThrow("deletion capability");
    expect(project(source)).not.toHaveProperty("canDelete");
  });
});
