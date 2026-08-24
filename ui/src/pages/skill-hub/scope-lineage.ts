import type { PlatformClawManagedScope } from "../../platformclaw/skill-hub.ts";

export function skillHubScopeLineageLabel(
  scopeId: string,
  scopes: readonly PlatformClawManagedScope[],
): string {
  const byId = new Map(scopes.map((scope) => [scope.id, scope]));
  const names: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(scopeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.push(current.name);
    current = current.parentScopeId ? byId.get(current.parentScopeId) : undefined;
  }
  return names.toReversed().join(" / ") || scopeId;
}
