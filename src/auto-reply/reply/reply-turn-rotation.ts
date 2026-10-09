import type { SessionDatabaseIdentity } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  captureReplyRunAdmissionSource,
  replyRunRegistry,
  type ReplyOperation,
  type ReplyRunAdmissionSource,
} from "./reply-run-registry.js";

/** Retain owner evidence across preparation and waits; never infer rotation from a new UUID alone. */
export function createReplyTurnRotationEvidence(params: {
  sessionKey: string;
  expectedActiveOperations?: readonly ReplyOperation[];
  activeAtAdmission?: ReplyOperation;
}) {
  const retainedSources: (ReplyRunAdmissionSource & { fromBarrier: boolean })[] = [];
  const isCurrent = (source: ReplyRunAdmissionSource & { fromBarrier: boolean }) =>
    source.sessionKey === params.sessionKey &&
    source.operation.lifecycleGeneration === getAgentEventLifecycleGeneration() &&
    !(
      source.operation.result?.kind === "aborted" &&
      source.operation.result.code === "aborted_for_restart"
    ) &&
    (source.fromBarrier ||
      (source.operation.key === params.sessionKey &&
        (source.operation === replyRunRegistry.get(params.sessionKey) ||
          source.operation.result !== null)));

  const sources = () => [
    ...retainedSources,
    ...Array.from(
      new Set([
        ...(params.expectedActiveOperations ?? []),
        params.activeAtAdmission,
        replyRunRegistry.get(params.sessionKey),
      ]),
    ).flatMap((operation) =>
      operation ? [{ ...captureReplyRunAdmissionSource(operation), fromBarrier: false }] : [],
    ),
  ];

  return {
    recordBarrierSources(barrierSources: ReplyRunAdmissionSource[] = []) {
      for (const source of barrierSources) {
        retainedSources.push({
          ...source,
          sessionIds: new Set(source.sessionIds),
          fromBarrier: true,
        });
      }
    },
    recordCompletedOperation(operation: ReplyOperation) {
      retainedSources.push({ ...captureReplyRunAdmissionSource(operation), fromBarrier: false });
    },
    takeStorelessRotation(expectedSessionId?: string) {
      return sources()
        .toReversed()
        .find(
          (source) =>
            source.databaseIdentity === undefined &&
            isCurrent(source) &&
            (!expectedSessionId || source.sessionIds.has(expectedSessionId)),
        );
    },
    hasExpectedSessionRotation(target: {
      expectedSessionId: string | undefined;
      sessionId: string | undefined;
      databaseIdentity: SessionDatabaseIdentity;
    }): boolean {
      if (!target.expectedSessionId || !target.databaseIdentity.isCurrent()) {
        return false;
      }
      const candidates = sources().filter(
        (source) =>
          isCurrent(source) &&
          source.databaseIdentity?.identity === target.databaseIdentity.identity &&
          source.databaseIdentity.isCurrent(),
      );
      // Several owners can compact while preparation or delivery is pending.
      // Only intersecting, same-store snapshots may extend the accepted lineage.
      const connectedIds = new Set([target.expectedSessionId]);
      let extended: boolean;
      do {
        extended = false;
        for (const source of candidates) {
          if (!Array.from(source.sessionIds).some((id) => connectedIds.has(id))) {
            continue;
          }
          if (source.sessionId === target.sessionId) {
            return true;
          }
          for (const id of source.sessionIds) {
            if (!connectedIds.has(id)) {
              connectedIds.add(id);
              extended = true;
            }
          }
        }
      } while (extended);
      return false;
    },
  };
}
