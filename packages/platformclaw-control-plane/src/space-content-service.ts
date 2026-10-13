import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { BrowserGatewayRpc } from "./browser-gateway-contracts.js";
import { ControlPlaneAuthorizationError } from "./contracts.js";
import {
  spaceContentProofPayloadHash,
  type SpaceContentMutation,
} from "./space-content-contracts.js";
import type { SqliteControlPlaneStore } from "./sqlite-store.js";

export async function mutateSpaceContent(
  store: SqliteControlPlaneStore,
  gateway: BrowserGatewayRpc,
  input: { proofId: string; payload: SpaceContentMutation },
) {
  let authorization: unknown;
  try {
    authorization = await gateway.request("platformclaw.spaces.run.authorize", {
      proofId: input.proofId,
      payloadHash: spaceContentProofPayloadHash(input.payload),
    });
  } catch {
    throw new ControlPlaneAuthorizationError("Active personal Space execution unavailable");
  }
  if (
    !isRecord(authorization) ||
    ["agentId", "sessionKey", "runtimeRunId", "admissionRunId"].some(
      (key) =>
        typeof authorization[key] !== "string" ||
        !authorization[key] ||
        (authorization[key] as string).length > 1000,
    )
  ) {
    throw new ControlPlaneAuthorizationError("Active personal Space execution unavailable");
  }
  return store.spaces.content.mutate(
    {
      agentId: authorization.agentId as string,
      sessionKey: authorization.sessionKey as string,
      runtimeRunId: authorization.runtimeRunId as string,
      admissionRunId: authorization.admissionRunId as string,
    },
    input.payload,
  );
}
