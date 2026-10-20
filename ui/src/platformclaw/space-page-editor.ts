import type {
  Space,
  SpacePage,
} from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import { platformClawT } from "./i18n.ts";
import type { SpaceSnapshot } from "./space-gateway-request.ts";

type CreateKind = "space" | "page" | "conversation";
type SavedDraft = { kind: "space"; space: Space } | { kind: "page"; page: SpacePage };

/** Owns the draft and its original revision independently of refreshed server snapshots. */
export class SpacePageEditor {
  editing: SpacePage | null = null;
  creating: CreateKind | null = null;
  title = "";
  body = "";
  requestId = crypto.randomUUID();
  private parentId: string | undefined;
  private suspendedDraft: { userId: string; selection: string; pageId: string | null } | null =
    null;
  constructor(private readonly changed: () => void) {}

  get active() {
    return Boolean(this.creating || this.editing);
  }
  get view() {
    return this.active && !this.suspendedDraft
      ? {
          kind: this.creating ?? ("edit" as const),
          title: this.title,
          body: this.body,
          revision: this.editing?.revision,
        }
      : null;
  }
  get suspended() {
    return this.suspendedDraft !== null;
  }
  suspend(userId: string | undefined, selection: string, pageId: string | null) {
    if (!this.active) {
      return;
    }
    if (!userId) {
      this.clear();
      return;
    }
    // A reconnect cannot display or submit a draft until fresh authorization
    // proves its original employee and selection; keep the original revision.
    this.suspendedDraft = { userId, selection, pageId };
    this.changed();
  }
  resume(userId: string | undefined, selection: string) {
    if (!this.suspendedDraft) {
      return;
    }
    if (this.suspendedDraft.userId !== userId || this.suspendedDraft.selection !== selection) {
      this.clear();
      return;
    }
    this.suspendedDraft = null;
    this.changed();
  }
  revalidate(snapshot: SpaceSnapshot, page: SpacePage | null, selection: string) {
    // Creating a Space is an employee capability; the selected Space's viewer
    // role restricts only drafts that would write into that existing Space.
    if (
      (snapshot.space.role === "viewer" && this.creating !== "space") ||
      (this.suspendedDraft?.pageId && this.suspendedDraft.pageId !== page?.id) ||
      (this.editing && this.editing.id !== page?.id) ||
      (this.creating === "conversation" && !page) ||
      (this.parentId && !snapshot.pages.some((candidate) => candidate.id === this.parentId))
    ) {
      this.clear();
      return;
    }
    this.resume(snapshot.currentUserId, selection);
  }
  open(kind: CreateKind, parentId?: string) {
    this.suspendedDraft = null;
    this.editing = null;
    this.creating = kind;
    this.parentId = kind === "page" ? parentId : undefined;
    this.title =
      kind === "conversation" ? platformClawT("platformClaw.spaces.newConversation") : "";
    this.body = "";
    this.requestId = crypto.randomUUID();
    this.changed();
  }
  clear() {
    this.suspendedDraft = null;
    if (!this.active && !this.title && !this.body) {
      return;
    }
    this.editing = null;
    this.creating = null;
    this.parentId = undefined;
    this.title = "";
    this.body = "";
    this.changed();
  }
  edit(page: SpacePage) {
    this.suspendedDraft = null;
    this.parentId = undefined;
    this.editing = page;
    this.title = page.title;
    this.body = page.body;
    this.changed();
  }
  replaceSaved(page: SpacePage, currentPage: SpacePage | null, canEdit: boolean) {
    if (!canEdit || this.suspended || this.editing?.id !== page.id || currentPage !== page) {
      return false;
    }
    this.edit(page);
    return true;
  }
  change(field: "title" | "body", value: string) {
    this[field] = value;
    this.requestId = crypto.randomUUID();
    this.changed();
  }
  async save(
    spaceId: string | undefined,
    request: <T>(method: string, params: Record<string, unknown>) => Promise<T>,
  ): Promise<SavedDraft | null> {
    if (this.suspended) {
      return null;
    }
    if (this.creating === "space") {
      const space = await request<Space>("create", { name: this.title, requestId: this.requestId });
      this.clear();
      return { kind: "space", space };
    }
    if (!spaceId) {
      return null;
    }
    let page: SpacePage;
    if (this.creating === "page") {
      page = await request<SpacePage>("page.create", {
        spaceId,
        ...(this.parentId ? { parentId: this.parentId } : {}),
        title: this.title,
        body: this.body,
        requestId: this.requestId,
      });
    } else if (this.editing) {
      page = await request<SpacePage>("page.save", {
        spaceId: this.editing.spaceId,
        pageId: this.editing.id,
        title: this.title,
        body: this.body,
        expectedRevision: this.editing.revision,
      });
    } else {
      return null;
    }
    this.clear();
    return { kind: "page", page };
  }
}
