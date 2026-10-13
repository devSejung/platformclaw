import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { WikiHubMemoryClient } from "./client.js";
import { registerSpaceMutationTools } from "./space-mutation-tools.js";
import type { registerSpaceRunProofs } from "./space-run-proof.js";

function fixture() {
  const registerTool = vi.fn();
  const spaceMutation = vi.fn(async () => ({
    revision: 2,
    receiptId: "receipt",
    link: "/platformclaw/app/spaces?space=test&page=issue&tab=qa&post=post",
  }));
  const issue = vi.fn(() => "p".repeat(43));
  registerSpaceMutationTools(
    { registerTool } as unknown as OpenClawPluginApi,
    { spaceMutation } as unknown as WikiHubMemoryClient,
    { issue } as ReturnType<typeof registerSpaceRunProofs>,
  );
  const context = {
    agentId: "person-a",
    sessionKey: "agent:person-a:space-session:11111111-1111-1111-1111-111111111111",
    runId: "runtime-a",
  };
  return {
    context,
    issue,
    spaceMutation,
    factories: registerTool.mock.calls.map((call) => call[0]),
  };
}

describe("shared Space mutation tools", () => {
  it("uses private runtime proof and preserves the logical request on retry", async () => {
    const f = fixture();
    const tool = f.factories[0](f.context);
    const payload = {
      body: "Q: Synthetic question\nA: Synthetic answer",
      expectedRevision: 1,
      requestId: "qa-one",
    };
    const result = await tool.execute("call", payload);
    await tool.execute("retry", payload);
    expect(f.issue).toHaveBeenCalledWith(f.context, { ...payload, operation: "qa.append" });
    expect(f.spaceMutation).toHaveBeenCalledWith({
      ...payload,
      operation: "qa.append",
      proofId: "p".repeat(43),
    });
    expect(f.spaceMutation.mock.calls[0]).toEqual(f.spaceMutation.mock.calls[1]);
    expect(result.details).toMatchObject({
      revision: 2,
      receiptId: "receipt",
      link: expect.stringContaining("tab=qa"),
    });
    expect(JSON.stringify(result)).not.toContain("Synthetic answer");
    for (const name of ["userId", "actorUserId", "agentId", "sessionKey", "runId", "proofId"]) {
      expect(tool.parameters.properties[name]).toBeUndefined();
    }
  });

  it.each(["actorUserId", "userId", "agentId", "sessionKey", "runId", "proofId"])(
    "rejects forged %s before issuing proof",
    async (key) => {
      const f = fixture();
      const result = await f.factories[0](f.context).execute("call", {
        body: "Shared synthetic post",
        expectedRevision: 1,
        requestId: "one",
        [key]: "forged",
      });
      expect(result).toMatchObject({ isError: true, details: { code: "space-invalid" } });
      expect(f.issue).not.toHaveBeenCalled();
      expect(f.spaceMutation).not.toHaveBeenCalled();
    },
  );

  it("patches exact selected text and appends to initially empty Notes", async () => {
    const f = fixture();
    const tool = f.factories[1](f.context);
    await tool.execute("replace", {
      operation: "replace",
      oldText: "obsolete",
      newText: "",
      expectedRevision: 5,
      requestId: "note-one",
    });
    expect(f.spaceMutation).toHaveBeenLastCalledWith({
      operation: "note.replace",
      oldText: "obsolete",
      newText: "",
      expectedRevision: 5,
      requestId: "note-one",
      proofId: "p".repeat(43),
    });
    await tool.execute("append", {
      operation: "append",
      text: "First shared note",
      expectedRevision: 1,
      requestId: "note-two",
    });
    expect(f.spaceMutation).toHaveBeenLastCalledWith({
      operation: "note.append",
      text: "First shared note",
      expectedRevision: 1,
      requestId: "note-two",
      proofId: "p".repeat(43),
    });
  });

  it.each([
    { operation: "replace", oldText: "", newText: "overwrite" },
    { operation: "append", text: "new", oldText: "old" },
    { operation: "replace", oldText: "old", newText: "한".repeat(3000) },
  ])("rejects unsafe or oversized note mutation", async (payload) => {
    const f = fixture();
    const result = await f.factories[1](f.context).execute("bad", {
      ...payload,
      expectedRevision: 1,
      requestId: "bad",
    });
    expect(result.isError).toBe(true);
    expect(f.issue).not.toHaveBeenCalled();
  });

  it("hides writes outside personal Space conversations and redacts proof errors", async () => {
    const f = fixture();
    for (const factory of f.factories) {
      expect(factory({ agentId: "person-a", sessionKey: "agent:person-a:main" })).toBeNull();
    }
    f.issue.mockImplementation(() => {
      throw Object.assign(new Error("internal path and credential"), {
        memoryCorpusFailure: {
          code: "space-forbidden",
          error: "Current execution ended",
          action: "Retry in your own active conversation",
        },
      });
    });
    const result = await f.factories[0](f.context).execute("ended", {
      body: "Synthetic",
      expectedRevision: 1,
      requestId: "ended",
    });
    expect(result).toMatchObject({
      isError: true,
      details: { code: "space-forbidden", error: "Current execution ended" },
    });
    expect(JSON.stringify(result)).not.toMatch(/internal|credential/u);
    expect(f.spaceMutation).not.toHaveBeenCalled();
  });
});
