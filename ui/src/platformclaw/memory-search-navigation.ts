import type { ApplicationGateway } from "../app/gateway.ts";
import type { MemorySearchNavigationState } from "../pages/config/memory-search-navigation.ts";

type MemoryNavigationOwner = {
  client: NonNullable<ApplicationGateway["snapshot"]["client"]>;
  userId: string | null;
  agentId: string;
  state: MemorySearchNavigationState;
  unsubscribe: (() => void) | null;
};

const navigationOwners = new WeakMap<ApplicationGateway, MemoryNavigationOwner>();

export function platformClawMemoryNavigationState(
  gateway: ApplicationGateway,
  agentId: string,
): MemorySearchNavigationState | null {
  const snapshot = gateway.snapshot;
  if (!snapshot.client || snapshot.phase === "stopped") {
    return null;
  }
  let owner = navigationOwners.get(gateway);
  if (
    owner &&
    (owner.client !== snapshot.client ||
      (snapshot.phase === "connected" && (snapshot.selfUser?.id ?? null) !== owner.userId))
  ) {
    owner.unsubscribe?.();
    navigationOwners.delete(gateway);
    owner = undefined;
  }
  if (owner && owner.agentId !== agentId) {
    owner.agentId = agentId;
    owner.state = emptyNavigationState();
  }
  if (!owner) {
    owner = {
      client: snapshot.client,
      userId: snapshot.selfUser?.id ?? null,
      agentId,
      state: emptyNavigationState(),
      unsubscribe: null,
    };
    navigationOwners.set(gateway, owner);
    const expectedOwner = owner;
    // A transient disconnect retains the current page's offline reading contract.
    // New clients/accounts and logout retire even navigation intent while unmounted.
    owner.unsubscribe = gateway.subscribe((current) => {
      if (
        current.client !== expectedOwner.client ||
        current.phase === "stopped" ||
        (current.phase === "connected" && (current.selfUser?.id ?? null) !== expectedOwner.userId)
      ) {
        navigationOwners.delete(gateway);
        expectedOwner.unsubscribe?.();
      }
    });
  }
  return owner.state;
}

function emptyNavigationState(): MemorySearchNavigationState {
  return { kind: "draft", query: "", sourceFilter: "all", selectedResult: null, scrollTop: 0 };
}
