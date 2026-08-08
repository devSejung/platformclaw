import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";

type GatewayMethodCatalog = Parameters<typeof isGatewayMethodAdvertised>[0];

export function supportsSessionWorkspace(snapshot: GatewayMethodCatalog): boolean {
  return ["sessions.files.list", "sessions.files.get"].every(
    (method) => isGatewayMethodAdvertised(snapshot, method) === true,
  );
}
