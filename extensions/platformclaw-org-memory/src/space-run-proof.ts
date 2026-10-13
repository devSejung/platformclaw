import { createHash, randomBytes } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type OperationTarget = {
  spaceId?: string;
  pageId?: string;
  expectedRevision: number;
  requestId: string;
};
export type SpaceRunOperationPayload = OperationTarget &
  (
    | { operation: "qa.append"; body: string }
    | { operation: "note.append"; text: string }
    | { operation: "note.replace"; oldText: string; newText: string }
  );

type RunContext = { runId?: string; agentId?: string; sessionKey?: string };
type ActiveAuthorization = NonNullable<
  ReturnType<OpenClawPluginApi["runContext"]["resolveActiveAuthorization"]>
>;
type Proof = { owner: symbol; authorization: ActiveAuthorization; payloadHash: string };
const MAX_RUN_PROOFS = 64;
const MAX_PROOFS = 512;
const PROOFS_KEY: unique symbol = Symbol.for("platformclaw.spaceRunProofs");
// Active and discovery registries can instantiate separate plugin modules in one gateway.
// Share only hashes and sealed host handles; shared content never enters this bounded store.
const proofState = globalThis as typeof globalThis & { [PROOFS_KEY]?: Map<string, Proof> };
const proofs = (proofState[PROOFS_KEY] ??= new Map<string, Proof>());

/** Transport contract: fixed field order, exact strings, absent target selectors are null. */
function hashSpaceRunOperation(payload: SpaceRunOperationPayload): string {
  const fields =
    payload.operation === "qa.append"
      ? [payload.body]
      : payload.operation === "note.append"
        ? [payload.text]
        : [payload.oldText, payload.newText];
  return createHash("sha256")
    .update(
      JSON.stringify([
        payload.operation,
        payload.spaceId ?? null,
        payload.pageId ?? null,
        payload.expectedRevision,
        payload.requestId,
        fields,
      ]),
      "utf8",
    )
    .digest("hex");
}

function pruneProofs() {
  for (const [proofId, proof] of proofs) {
    if (!proof.authorization.isActive()) {
      proofs.delete(proofId);
    }
  }
}

function publicProofFailure(error: string, action: string): Error {
  return Object.assign(new Error(error), {
    memoryCorpusFailure: { code: "space-forbidden", error, action },
  });
}

export function registerSpaceRunProofs(api: OpenClawPluginApi) {
  // Registry replacement installs new issuers before asynchronously cleaning
  // old instances. An old cleanup must never retire a new issuer's proof.
  const owner = Symbol("space-run-proof-owner");
  api.registerGatewayMethod(
    "platformclaw.spaces.run.authorize",
    ({ params, respond }) => {
      const input = asOptionalRecord(params);
      const proofId = input?.proofId;
      const payloadHash = input?.payloadHash;
      const valid =
        input &&
        Object.keys(input).length === 2 &&
        typeof proofId === "string" &&
        /^[A-Za-z0-9_-]{43}$/u.test(proofId) &&
        typeof payloadHash === "string" &&
        /^[a-f0-9]{64}$/u.test(payloadHash);
      const proof = valid && typeof proofId === "string" ? proofs.get(proofId) : undefined;
      if (!proof || proof.payloadHash !== payloadHash || !proof.authorization.isActive()) {
        if (proof && !proof.authorization.isActive()) {
          proofs.delete(proofId as string);
        }
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message:
            "Active Space write authorization unavailable; retry from your personal Space conversation",
        });
        return;
      }
      const { agentId, sessionKey, runtimeRunId, admissionRunId } = proof.authorization;
      respond(true, { agentId, sessionKey, runtimeRunId, admissionRunId });
    },
    { scope: "operator.admin" },
  );
  api.agent.events.registerAgentEventSubscription({
    id: "space-run-proofs",
    streams: ["lifecycle"],
    handle(event) {
      if (event.data.phase === "end" || event.data.phase === "error") {
        for (const [proofId, proof] of proofs) {
          if (proof.owner === owner && proof.authorization.runtimeRunId === event.runId) {
            proofs.delete(proofId);
          }
        }
      }
    },
  });
  api.lifecycle.registerRuntimeLifecycle({
    id: "space-run-proofs",
    cleanup({ runId, sessionKey }) {
      for (const [proofId, proof] of proofs) {
        if (
          proof.owner === owner &&
          ((!runId && !sessionKey) ||
            proof.authorization.runtimeRunId === runId ||
            proof.authorization.sessionKey === sessionKey)
        ) {
          proofs.delete(proofId);
        }
      }
    },
  });
  return {
    issue(context: RunContext, payload: SpaceRunOperationPayload): string {
      pruneProofs();
      const authorization = api.runContext.resolveActiveAuthorization(context);
      if (!authorization?.isActive()) {
        throw publicProofFailure(
          "An active current personal Space run is required to save shared content.",
          "Start or retry this request in your own personal conversation on the Space page.",
        );
      }
      let runProofs = 0;
      for (const proof of proofs.values()) {
        if (proof.authorization.runtimeRunId === authorization.runtimeRunId) {
          runProofs++;
        }
      }
      if (runProofs >= MAX_RUN_PROOFS || proofs.size >= MAX_PROOFS) {
        throw publicProofFailure(
          "Too many active Space write requests.",
          "Retry after the current shared content writes complete.",
        );
      }
      const proofId = randomBytes(32).toString("base64url");
      proofs.set(proofId, { owner, authorization, payloadHash: hashSpaceRunOperation(payload) });
      return proofId;
    },
  };
}
