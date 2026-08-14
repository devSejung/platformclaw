import type { SkillStatusReport } from "../../api/types.ts";
import { canCallWorkshopAdminMethod } from "./access.ts";
import type { SkillWorkshopState } from "./proposals.ts";
import { resolveSelfLearning } from "./self-learning.ts";
import type { SkillWorkshopPageContext } from "./source-scope.ts";

type LoadPersonalAccessOptions = {
  context: SkillWorkshopPageContext;
  loadServerProposals: () => Promise<unknown>;
  onError: (error: unknown) => void;
  onUpdate: () => void;
};

export class SkillWorkshopPersonalAccess {
  target: SkillStatusReport["executionTarget"] | null = null;
  loading = false;
  private attempted = false;
  private epoch = 0;

  targetFor(context: SkillWorkshopPageContext) {
    return context.accessMode === "personal-agent" ? this.target : undefined;
  }

  reset() {
    this.epoch += 1;
    this.target = null;
    this.loading = false;
    this.attempted = false;
  }

  prepareRetry(force: boolean, error: string | null): string | null {
    if (!force || !error) {
      return error;
    }
    this.reset();
    return null;
  }

  async load(options: LoadPersonalAccessOptions): Promise<void> {
    const client = options.context.gateway.snapshot.client;
    if (!client || this.loading || this.attempted) {
      return;
    }
    const epoch = this.epoch;
    this.attempted = true;
    this.loading = true;
    options.onUpdate();
    try {
      const report = await client.request<SkillStatusReport>("skills.status", {});
      if (this.epoch !== epoch || options.context.gateway.snapshot.client !== client) {
        return;
      }
      this.target = report.executionTarget ?? "platform_server";
      await options.loadServerProposals();
    } catch (error) {
      if (this.epoch === epoch) {
        options.onError(error);
      }
    } finally {
      if (this.epoch === epoch && options.context.gateway.snapshot.client === client) {
        this.loading = false;
        options.onUpdate();
      }
    }
  }
}

export function loadSkillWorkshopProposals(params: {
  access: SkillWorkshopPersonalAccess;
  context: SkillWorkshopPageContext | null | undefined;
  state: SkillWorkshopState | null | undefined;
  force: boolean;
  runProposals: (
    args: [SkillWorkshopPageContext, SkillWorkshopState, string | null, boolean],
  ) => Promise<unknown>;
  onUpdate: () => void;
}): void {
  const { context, state } = params;
  if (!state || !context || context.gateway.snapshot.phase !== "connected") {
    return;
  }
  if (context.accessMode === "personal-agent") {
    state.skillWorkshopError = params.access.prepareRetry(params.force, state.skillWorkshopError);
    if (params.access.target === null) {
      void params.access.load({
        context,
        loadServerProposals: () =>
          params.runProposals([
            context,
            state,
            context.agentSelection.state.selectedId,
            params.force,
          ]),
        onError: (error) => {
          state.skillWorkshopError =
            error instanceof Error ? error.message : "Could not load the current work location.";
        },
        onUpdate: params.onUpdate,
      });
      return;
    }
  }
  void params.runProposals([context, state, context.agentSelection.state.selectedId, params.force]);
}

export function resolvePersonalAwareSelfLearning(params: {
  context: SkillWorkshopPageContext;
  busy: boolean;
  error: string | null;
}) {
  return params.context.accessMode === "personal-agent"
    ? null
    : resolveSelfLearning(
        params.context.runtimeConfig,
        params.busy,
        params.error,
        canCallWorkshopAdminMethod(params.context.gateway.snapshot, "config.patch"),
      );
}
