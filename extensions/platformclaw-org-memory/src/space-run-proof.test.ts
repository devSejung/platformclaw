import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hashSpaceRunOperation,
  registerSpaceRunProofs,
  type SpaceRunOperationPayload,
} from "./space-run-proof.js";

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type Cleanup = Parameters<OpenClawPluginApi["lifecycle"]["registerRuntimeLifecycle"]>[0];
type Subscription = Parameters<
  OpenClawPluginApi["agent"]["events"]["registerAgentEventSubscription"]
>[0];
const payload: SpaceRunOperationPayload = {
  operation: "qa.append",
  expectedRevision: 1,
  requestId: "request",
  body: "Question\nAnswer",
};
const cleanups: Cleanup[] = [];

function fixture(register = registerSpaceRunProofs) {
  const state = { active: true };
  const authorization = {
    agentId: "personal-alice",
    sessionKey: "agent:personal-alice:space-session:issue",
    runtimeRunId: "runtime",
    admissionRunId: "ingress",
    isActive: () => state.active,
  };
  let handler: Handler | undefined;
  let subscription: Subscription | undefined;
  const api = {
    runContext: {
      resolveActiveAuthorization: vi.fn(() => (state.active ? authorization : undefined)),
    },
    registerGatewayMethod: vi.fn((_name: string, registered: Handler) => {
      handler = registered;
    }),
    agent: {
      events: {
        registerAgentEventSubscription: (value: Subscription) => {
          subscription = value;
        },
      },
    },
    lifecycle: {
      registerRuntimeLifecycle: (value: Cleanup) => {
        cleanups.push(value);
      },
    },
  } as unknown as OpenClawPluginApi;
  const issuer = register(api);
  const verify = async (
    proofId: string,
    payloadHash = hashSpaceRunOperation(payload),
    extra = {},
  ) => {
    const respond = vi.fn();
    await handler!({
      req: { type: "req", id: "space-proof", method: "platformclaw.spaces.run.authorize" },
      params: { proofId, payloadHash, ...extra },
      client: null,
      isWebchatConnect: () => false,
      respond,
      // This callback unit consumes only params/respond; unexpected context access must fail.
      get context(): never {
        throw new Error("Space proof callback must not access Gateway execution context");
      },
    });
    return respond;
  };
  return { issuer, verify, api, state, subscription: () => subscription! };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup.cleanup?.({ reason: "restart" });
  }
});

describe("Space operation proof", () => {
  it("binds a random 256-bit proof to the operation and returns only verified identity", async () => {
    const { issuer, verify, api } = fixture();
    const proofId = issuer.issue({}, payload);
    expect(proofId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await verify(proofId)).toHaveBeenCalledWith(true, {
      agentId: "personal-alice",
      sessionKey: "agent:personal-alice:space-session:issue",
      runtimeRunId: "runtime",
      admissionRunId: "ingress",
    });
    expect(await verify(proofId)).toHaveBeenCalledWith(true, expect.any(Object));
    expect(api.registerGatewayMethod).toHaveBeenCalledWith(
      "platformclaw.spaces.run.authorize",
      expect.any(Function),
      { scope: "operator.admin" },
    );
  });

  it("rejects unknown proofs, altered operations and all selectable owner fields", async () => {
    const { issuer, verify } = fixture();
    const proofId = issuer.issue({}, payload);
    for (const response of [
      await verify("a".repeat(43)),
      await verify(proofId, hashSpaceRunOperation({ ...payload, body: "changed" })),
      await verify(proofId, hashSpaceRunOperation(payload), { agentId: "personal-bob" }),
      await verify(proofId, hashSpaceRunOperation(payload), { runId: "known-active-run" }),
    ]) {
      expect(response).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    expect(await verify(proofId)).toHaveBeenCalledWith(true, expect.any(Object));
  });

  it("rejects delayed verification after cancellation or tool completion", async () => {
    const { issuer, verify, state } = fixture();
    const proofId = issuer.issue({}, payload);
    state.active = false;
    expect(await verify(proofId)).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(() => issuer.issue({}, payload)).toThrow(
      "An active current personal Space run is required",
    );
    try {
      issuer.issue({}, payload);
    } catch (error) {
      expect(error).toMatchObject({
        memoryCorpusFailure: {
          code: "space-forbidden",
          action: expect.stringContaining("own personal conversation"),
        },
      });
    }
  });

  it("shares proofs with the privileged active registry and clears them on run retirement", async () => {
    const issuing = fixture();
    const verifying = fixture();
    const proofId = issuing.issuer.issue({}, payload);
    expect(await verifying.verify(proofId)).toHaveBeenCalledWith(true, expect.any(Object));
    await issuing
      .subscription()
      .handle(
        { runId: "runtime", stream: "lifecycle", data: { phase: "end" }, seq: 1, ts: 1 },
        {} as Parameters<Subscription["handle"]>[1],
      );
    expect(await verifying.verify(proofId)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.any(Object),
    );
  });

  it("shares the bounded private proof store across separate plugin module instances", async () => {
    const issuing = fixture();
    const proofId = issuing.issuer.issue({}, payload);
    vi.resetModules();
    const reloaded = await import("./space-run-proof.js");
    const verifying = fixture(reloaded.registerSpaceRunProofs);
    expect(await verifying.verify(proofId)).toHaveBeenCalledWith(true, expect.any(Object));
  });

  it("keeps a new registry's proof live after the old registry's unscoped cleanup", async () => {
    const oldRegistry = fixture();
    const oldProof = oldRegistry.issuer.issue({}, payload);
    const newRegistry = fixture();
    const newProof = newRegistry.issuer.issue({}, payload);
    await cleanups[0]!.cleanup?.({ reason: "restart" });
    expect(await newRegistry.verify(oldProof)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.any(Object),
    );
    expect(await newRegistry.verify(newProof)).toHaveBeenCalledWith(true, expect.any(Object));
    await oldRegistry
      .subscription()
      .handle(
        { runId: "runtime", stream: "lifecycle", data: { phase: "end" }, seq: 1, ts: 1 },
        {} as Parameters<Subscription["handle"]>[1],
      );
    expect(await newRegistry.verify(newProof)).toHaveBeenCalledWith(true, expect.any(Object));
  });

  it("bounds retained proof handles and releases them on restart", async () => {
    const { issuer, verify } = fixture();
    const proofId = issuer.issue({}, payload);
    for (let index = 1; index < 64; index++) {
      issuer.issue({}, { ...payload, requestId: `request-${index}` });
    }
    expect(() => issuer.issue({}, payload)).toThrow("Too many active Space write requests");
    await cleanups[0]!.cleanup?.({ reason: "restart" });
    expect(await verify(proofId)).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(issuer.issue({}, payload)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it.each([
    payload,
    {
      operation: "note.append",
      spaceId: "space",
      pageId: "page",
      expectedRevision: 2,
      requestId: "append",
      text: '\u0000"한글😀',
    },
    {
      operation: "note.replace",
      expectedRevision: 3,
      requestId: "replace",
      oldText: "old",
      newText: "",
    },
  ] satisfies SpaceRunOperationPayload[])(
    "uses the fixed-order cross-service hash contract for $operation",
    (input) => {
      const fields =
        input.operation === "qa.append"
          ? [input.body]
          : input.operation === "note.append"
            ? [input.text]
            : [input.oldText, input.newText];
      const expected = createHash("sha256")
        .update(
          JSON.stringify([
            input.operation,
            input.spaceId ?? null,
            input.pageId ?? null,
            input.expectedRevision,
            input.requestId,
            fields,
          ]),
          "utf8",
        )
        .digest("hex");
      expect(hashSpaceRunOperation(input)).toBe(expected);
    },
  );
});
