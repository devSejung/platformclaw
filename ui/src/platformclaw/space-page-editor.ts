import type {
  Space,
  SpacePage,
} from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import { platformClawT } from "./i18n.ts";

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
  constructor(private readonly changed: () => void) {}

  get active() {
    return Boolean(this.creating || this.editing);
  }
  get view() {
    return this.active
      ? {
          kind: this.creating ?? ("edit" as const),
          title: this.title,
          body: this.body,
          revision: this.editing?.revision,
        }
      : null;
  }
  open(kind: CreateKind, parentId?: string) {
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
    if (!this.active && !this.title && !this.body) {
      return;
    }
    this.editing = null;
    this.creating = null;
    this.title = "";
    this.body = "";
    this.changed();
  }
  edit(page: SpacePage) {
    this.editing = page;
    this.title = page.title;
    this.body = page.body;
    this.changed();
  }
  replaceSaved(page: SpacePage, currentPage: SpacePage | null, canEdit: boolean) {
    if (!canEdit || this.editing?.id !== page.id || currentPage !== page) {
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
