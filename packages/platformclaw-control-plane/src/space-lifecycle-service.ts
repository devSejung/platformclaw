import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { BrowserGatewayRpc } from "./browser-gateway-contracts.js";
import { ControlPlaneStateError } from "./contracts.js";
import type { SpaceConversationService } from "./space-conversation-service.js";
import type { SqliteSpaceStore } from "./sqlite-spaces.js";

const SPACE_DELETION_RESULT = {
  deleted: true,
  scope: "space-pages-and-identifiable-conversation-records",
  retainedData: [
    "unattributed-archives",
    "untracked-derived-memory",
    "shared-files",
    "unowned-attachments-and-media-renditions",
    "worktree-snapshots",
    "spawned-session-transcripts",
    "external-backups",
  ],
} as const;

/** Owns durable Space removal and coalesces cleanup without restoring revoked access. */
export class SpaceLifecycleService {
  private readonly deleting = new Map<string, Promise<typeof SPACE_DELETION_RESULT>>();
  private readonly leaving = new Map<string, Promise<{ left: true }>>();
  constructor(
    private readonly spaces: SqliteSpaceStore,
    private readonly gateway: BrowserGatewayRpc,
    private readonly conversations: SpaceConversationService,
    private readonly changed: () => void,
    private readonly cancelRevoked: (
      space: { id: string; agentId: string },
      userId: string,
    ) => Promise<void>,
  ) {}
  async leave(userId: string, spaceId: string, revision: number): Promise<{ left: true }> {
    const departure = this.spaces.leave(userId, spaceId, revision);
    if (departure.state === "left") {
      return { left: true };
    }
    this.changed();
    const key = `${spaceId}:${userId}:${revision}`;
    let pending = this.leaving.get(key);
    if (!pending) {
      pending = this.cancelRevoked(departure.space, userId)
        .then(() => {
          this.spaces.finishLeave(userId, spaceId, revision);
          this.changed();
          return { left: true as const };
        })
        .finally(() => this.leaving.delete(key));
      this.leaving.set(key, pending);
    }
    return await pending;
  }
  async delete(
    userId: string,
    spaceId: string,
    revision: number,
    confirmName: string,
    revalidate: () => Promise<void>,
  ) {
    await revalidate();
    const deletion = this.spaces.beginDelete(userId, spaceId, revision, confirmName);
    if (deletion.state === "deleted") {
      return SPACE_DELETION_RESULT;
    }
    this.changed();
    let pending = this.deleting.get(spaceId);
    if (!pending) {
      pending = this.purgeSpace(userId, spaceId, deletion.agent_id).finally(() =>
        this.deleting.delete(spaceId),
      );
      this.deleting.set(spaceId, pending);
    }
    return await pending;
  }
  private async purgeSpace(
    userId: string,
    spaceId: string,
    agentId: string,
  ): Promise<typeof SPACE_DELETION_RESULT> {
    const sessions = this.spaces.deletionSessions(spaceId, agentId);
    await this.conversations.drainPreparation(sessions.map((session) => session.sessionKey));
    // Keep the registry/tombstone until every backing session confirms deletion. Native
    // lifecycle serialization drains admissions and queues, while the tombstone denies new work.
    for (const session of sessions) {
      try {
        const result = await this.gateway.request("sessions.delete", {
          // Fully qualified keys also identify historical agents no longer in runtime config.
          key: session.sessionKey,
          purgeTranscript: true,
        });
        if (
          !isRecord(result) ||
          result.ok !== true ||
          result.key !== session.sessionKey ||
          result.purged !== true ||
          result.purgeScope !== "owned-session-data"
        ) {
          throw new ControlPlaneStateError("Session purge outcome unavailable");
        }
      } catch (error) {
        if (
          isRecord(error) &&
          isRecord(error.details) &&
          error.details.reason === "session-purge-unsupported"
        ) {
          const backend = error.details.backend;
          const blocker =
            backend === "unavailable"
              ? "The memory cleanup owner is unavailable; ask an administrator to re-enable the owning memory plugin before retrying."
              : backend === "session-store"
                ? "Retained transcript generations need an administrator to restore or repair their session owner before retrying."
                : `${backend === "qmd" ? "QMD" : "The configured memory backend"} cannot permanently purge the owned session memory. Ask an administrator to resolve the backend limitation before retrying.`;
          throw new ControlPlaneStateError(
            `Space access removed; ${blocker} Some Space records may already be deleted.`,
          );
        }
        throw new ControlPlaneStateError(
          "Space access removed; permanent cleanup is incomplete. Retry deletion from the Space list.",
        );
      }
    }
    this.spaces.finishDelete(userId, spaceId);
    this.changed();
    return SPACE_DELETION_RESULT;
  }
}
