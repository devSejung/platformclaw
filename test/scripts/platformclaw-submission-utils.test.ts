import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot, resolveRepoPath } from "../../scripts/submission/submission-utils.mjs";

describe("submission path safety", () => {
  it("keeps repository-relative evidence paths inside the checkout", () => {
    expect(resolveRepoPath("submission/evaluation-map.yaml")).toBe(
      path.join(repoRoot, "submission", "evaluation-map.yaml"),
    );
  });

  it.each([
    "../outside",
    "submission/../../outside",
    path.resolve(path.parse(repoRoot).root, "outside"),
  ])("rejects an unsafe path: %s", (unsafePath) => {
    expect(() => resolveRepoPath(unsafePath)).toThrow("unsafe repository path");
  });
});
