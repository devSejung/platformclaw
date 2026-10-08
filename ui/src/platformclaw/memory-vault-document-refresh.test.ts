/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeVaultSnapshot } from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { mount, rpc, setupVaultTests, snapshot } from "./memory-vaults.test-support.ts";

setupVaultTests();
function named(name: string): KnowledgeVaultSnapshot {
  const value = snapshot();
  value.selected!.vault.name = name;
  return value;
}
describe("Wiki document mutation refresh ownership", () => {
  it("discards snapshots started before a later mutation and still completes the trailing refresh", async () => {
    const pending: Array<(value: KnowledgeVaultSnapshot) => void> = [];
    let initial = true;
    const request = vi.fn((method: string) => {
      if (method !== `${rpc}snapshot`) {
        return Promise.resolve({});
      }
      if (initial) {
        initial = false;
        return Promise.resolve(named("Initial vault"));
      }
      return new Promise<KnowledgeVaultSnapshot>((resolve) => {
        pending.push(resolve);
      });
    });
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("Initial vault"));
    element
      .querySelector(".vaults")!
      .dispatchEvent(new CustomEvent("vault-documents-changed", { bubbles: true }));
    await waitForFast(() => expect(pending).toHaveLength(1));
    element
      .querySelector(".vaults")!
      .dispatchEvent(new CustomEvent("vault-documents-changed", { bubbles: true }));
    pending[0]!(named("Stale pre-mutation vault"));
    await waitForFast(() => expect(pending).toHaveLength(2));
    expect(element.textContent).not.toContain("Stale pre-mutation vault");
    pending[1]!(named("Fresh post-mutation vault"));
    await waitForFast(() => expect(element.textContent).toContain("Fresh post-mutation vault"));
  });
});
