type PlatformClawTargetMutationKind = "target-change" | "skill-install" | "terminal-open";

type HeldMutation = { kind: PlatformClawTargetMutationKind; token: symbol };

/** Serializes target selection and workspace mutations for one personal Agent. */
export class PlatformClawTargetMutationCoordinator {
  private readonly held = new Map<string, HeldMutation>();

  tryAcquire(agentId: string, kind: PlatformClawTargetMutationKind): (() => void) | null {
    if (this.held.has(agentId)) {
      return null;
    }
    const token = Symbol(kind);
    this.held.set(agentId, { kind, token });
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (this.held.get(agentId)?.token === token) {
        this.held.delete(agentId);
      }
    };
  }

  isHeld(agentId: string, kind?: PlatformClawTargetMutationKind): boolean {
    const held = this.held.get(agentId);
    return held !== undefined && (kind === undefined || held.kind === kind);
  }
}
