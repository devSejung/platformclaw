import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import type { PersonalExecutionTarget } from "./execution-contracts.js";
import type {
  KnoxSelfSpaceIdentity,
  KnoxSelfSpaceResolution,
  KnoxSelfSpaceRoute,
} from "./knox-space-contracts.js";
import type { SpaceConversationService } from "./space-conversation-service.js";
import { knoxTargetIdentity } from "./sqlite-knox-space.js";
import type { SqliteControlPlaneStore } from "./sqlite-store.js";

const CONVERSATION_TITLE = "Knox /my";

/** Tool and approval boundaries recheck the original admitted target after asynchronous lookup. */
export function revalidateKnoxSpaceRun(
  store: SqliteControlPlaneStore,
  context: { agentId: string; sessionKey?: string; runId?: string },
): Promise<void> | undefined {
  const receipt = store.knoxSpaces.assertTargetRun(context);
  if (!receipt) {
    return undefined;
  }
  return (async () => {
    try {
      const target = await store.resolvePersonalExecutionTarget(context.agentId);
      // A restored target cannot grant an admission another authority writer revoked.
      store.knoxSpaces.assertTargetRun(context, target);
    } catch (error) {
      if (
        error instanceof ControlPlaneAuthorizationError ||
        error instanceof ControlPlaneStateError
      ) {
        store.knoxSpaces.revoke(receipt.id);
        throw new ControlPlaneAuthorizationError("Knox request is no longer authorized");
      }
      throw error;
    }
  })();
}

function conversationRequestId(bindingId: string, generation: number) {
  return `knox-my:${bindingId}:${generation}`;
}

/** This service owns the employee/Space admission. The Knox plugin owns delivery. */
export class KnoxSelfInSpaceService {
  constructor(
    private readonly store: SqliteControlPlaneStore,
    private readonly conversations: SpaceConversationService,
  ) {}

  async resolve(identity: KnoxSelfSpaceIdentity): Promise<KnoxSelfSpaceResolution> {
    const admissions = this.store.knoxSpaces;
    if (identity.operation === "settle") {
      return admissions.settle(identity);
    }
    const prior = admissions.receipt(identity);
    if (prior) {
      const result = admissions.resolution(prior, identity);
      if (result.status !== "resolved" || identity.operation !== "validate") {
        return result;
      }
      return await this.validate(identity, result);
    }
    if (identity.operation === "validate") {
      if (!identity.admissionId) {
        throw new ControlPlaneStateError("Admission identity required");
      }
      return { status: "request-conflict", admissionId: identity.admissionId };
    }
    const personal = await this.store.resolveAuthenticatedKnoxDmRoute({
      accountId: identity.knoxUserId,
    });
    let target: PersonalExecutionTarget | undefined;
    if (personal.status === "resolved") {
      try {
        target = await this.store.resolvePersonalExecutionTarget(personal.binding.agentId);
      } catch (error) {
        if (
          !(error instanceof ControlPlaneStateError) &&
          !(error instanceof ControlPlaneAuthorizationError)
        ) {
          throw error;
        }
      }
    }
    return admissions.reserve(identity, (admissionId) => {
      const failure = (status: Exclude<KnoxSelfSpaceResolution["status"], "resolved">) => ({
        result: { status, admissionId },
      });
      if (personal.status === "user-not-found") {
        return failure("login-required");
      }
      if (personal.status !== "resolved" || !target) {
        return failure("agent-unavailable");
      }
      const binding = admissions.binding(identity.accountId, identity.conversationId);
      const roomState = admissions.roomState(identity.accountId, identity.conversationId);
      if (roomState === "disabled") {
        return failure("room-disabled");
      }
      if (!binding || binding.state !== "active") {
        return failure("space-unavailable");
      }
      if (roomState !== "active") {
        return failure("agent-unavailable");
      }
      try {
        admissions.assertCurrentTarget(target);
        this.store.spaces.page(personal.user.id, binding.spaceId, binding.pageId, "editor");
        const conversation = this.conversations.reserve(
          personal.user.id,
          binding.spaceId,
          binding.pageId,
          CONVERSATION_TITLE,
          conversationRequestId(binding.id, binding.generation),
        );
        const result: KnoxSelfSpaceRoute = {
          status: "resolved",
          agentId: conversation.agentId,
          sessionKey: conversation.sessionKey,
          senderLinked: true,
          executionTarget: target.kind,
          selfInSpace: {
            admissionId,
            requestId: identity.requestId,
            userId: personal.user.id,
            spaceId: binding.spaceId,
            pageId: binding.pageId,
            bindingId: binding.id,
            bindingGeneration: binding.generation,
            conversationId: conversation.id,
            targetRevision: target.revision,
            senderAttribution: {
              id: identity.knoxUserId,
              name: personal.user.displayName || personal.user.accountId,
              profileId: personal.user.id,
              agentId: conversation.agentId,
            },
          },
        };
        return { result, target };
      } catch (error) {
        if (error instanceof ControlPlaneAuthorizationError) {
          return failure("permission-denied");
        }
        if (error instanceof ControlPlaneStateError) {
          return failure("space-unavailable");
        }
        throw error;
      }
    });
  }

  private async validate(
    identity: KnoxSelfSpaceIdentity,
    route: KnoxSelfSpaceRoute,
  ): Promise<KnoxSelfSpaceResolution> {
    const check = async (): Promise<KnoxSelfSpaceResolution> => {
      const admissions = this.store.knoxSpaces;
      const receipt = admissions.receipt(identity)!;
      const result = admissions.resolution(receipt, identity);
      if (result.status !== "resolved") {
        return result;
      }
      const fail = (status: "request-revoked" | "target-changed") => {
        admissions.revoke(receipt.id);
        return { status, admissionId: receipt.id } as const;
      };
      const binding = admissions.binding(identity.accountId, identity.conversationId);
      if (
        !binding ||
        binding.id !== route.selfInSpace.bindingId ||
        binding.generation !== route.selfInSpace.bindingGeneration ||
        binding.state !== "active" ||
        admissions.roomState(identity.accountId, identity.conversationId) !== "active"
      ) {
        return fail("request-revoked");
      }
      try {
        const personal = await this.store.resolveAuthenticatedKnoxDmRoute({
          accountId: identity.knoxUserId,
        });
        if (
          personal.status !== "resolved" ||
          personal.user.id !== route.selfInSpace.userId ||
          personal.binding.agentId !== route.agentId
        ) {
          return fail("request-revoked");
        }
        this.store.spaces.page(personal.user.id, binding.spaceId, binding.pageId, "editor");
        const current = this.store.spaces.conversationForSession(
          personal.user.id,
          route.sessionKey,
          true,
        );
        if (
          current.id !== route.selfInSpace.conversationId ||
          current.pageId !== binding.pageId ||
          current.spaceId !== binding.spaceId
        ) {
          return fail("request-revoked");
        }
        const target = await this.store.resolvePersonalExecutionTarget(route.agentId);
        if (knoxTargetIdentity(target) !== receipt.target_json) {
          return fail("target-changed");
        }
        // An asynchronous target lookup must not revive a receipt revoked by an authority writer.
        const latest = admissions.resolution(admissions.receipt(identity)!, identity);
        return latest.status === "resolved" ? route : latest;
      } catch (error) {
        if (
          error instanceof ControlPlaneAuthorizationError ||
          error instanceof ControlPlaneStateError
        ) {
          return fail("request-revoked");
        }
        throw error;
      }
    };
    const admitted = await check();
    if (admitted.status !== "resolved") {
      return admitted;
    }
    if (identity.phase === "publish") {
      return admitted;
    }
    await this.conversations.create(
      route.selfInSpace.userId,
      route.selfInSpace.spaceId,
      route.selfInSpace.pageId,
      CONVERSATION_TITLE,
      conversationRequestId(route.selfInSpace.bindingId, route.selfInSpace.bindingGeneration),
      async () => {
        const rechecked = await check();
        if (rechecked.status !== "resolved") {
          throw new ControlPlaneAuthorizationError("Knox request revoked");
        }
      },
    );
    return await check();
  }
}
