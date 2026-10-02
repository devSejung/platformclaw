import type { ApplicationContext } from "../app/context.ts";
import { platformClawT } from "./i18n.ts";

/** A response must still belong to the connected browser identity that requested it. */
export async function requestSpaceGateway<T>(
  context: () => ApplicationContext,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const gateway = context().gateway.snapshot;
  if (gateway.phase !== "connected" || !gateway.client) {
    throw new Error(platformClawT("platformClaw.spaces.disconnected"));
  }
  const client = gateway.client;
  const result = await client.request<T>("platformclaw.spaces." + method, params);
  if (
    client !== context().gateway.snapshot.client ||
    context().gateway.snapshot.phase !== "connected"
  ) {
    throw new Error(platformClawT("platformClaw.spaces.disconnected"));
  }
  return result;
}

export function spaceGatewayErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : platformClawT("platformClaw.spaces.failed");
}
