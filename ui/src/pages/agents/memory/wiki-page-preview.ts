import { t } from "../../../i18n/index.ts";

export type WikiPagePreview = {
  title: string;
  path: string;
  content: string;
  totalLines?: number;
  truncated?: boolean;
  updatedAt?: string;
  displayContent: string;
  sourceContent: string;
  editMode: "body" | "notes" | null;
  editableContent?: string;
  revision?: string;
  readOnlyReason?: "generated-report" | "source-managed" | "page-too-large";
  sourceType?: string;
  saved?: boolean;
  indexesRefreshed?: boolean;
};

export function readWikiPagePreview(value: unknown, lookup: string): WikiPagePreview {
  const payload =
    value && typeof value === "object"
      ? (value as {
          title?: unknown;
          path?: unknown;
          content?: unknown;
          updatedAt?: unknown;
          totalLines?: unknown;
          truncated?: unknown;
          displayContent?: unknown;
          sourceContent?: unknown;
          editMode?: unknown;
          editableContent?: unknown;
          revision?: unknown;
          readOnlyReason?: unknown;
          sourceType?: unknown;
        })
      : null;
  const title =
    typeof payload?.title === "string" && payload.title.trim() ? payload.title.trim() : lookup;
  const path =
    typeof payload?.path === "string" && payload.path.trim() ? payload.path.trim() : lookup;
  const content =
    typeof payload?.content === "string" && payload.content.length > 0
      ? payload.content
      : t("dreaming.wiki.noContent");
  const displayContent =
    typeof payload?.displayContent === "string" ? payload.displayContent : content;
  const sourceContent =
    typeof payload?.sourceContent === "string" ? payload.sourceContent : content;
  const editMode =
    payload?.editMode === "body" || payload?.editMode === "notes" ? payload.editMode : null;
  const updatedAt =
    typeof payload?.updatedAt === "string" && payload.updatedAt.trim()
      ? payload.updatedAt.trim()
      : undefined;
  const totalLines =
    typeof payload?.totalLines === "number" && Number.isFinite(payload.totalLines)
      ? Math.max(0, Math.floor(payload.totalLines))
      : undefined;
  return {
    title,
    path,
    content,
    displayContent,
    sourceContent,
    editMode,
    ...(totalLines === undefined ? {} : { totalLines }),
    ...(payload?.truncated === true ? { truncated: true } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(typeof payload?.editableContent === "string"
      ? { editableContent: payload.editableContent }
      : {}),
    ...(typeof payload?.revision === "string" ? { revision: payload.revision } : {}),
    ...(payload?.readOnlyReason === "generated-report" ||
    payload?.readOnlyReason === "source-managed" ||
    payload?.readOnlyReason === "page-too-large"
      ? { readOnlyReason: payload.readOnlyReason }
      : {}),
    ...(typeof payload?.sourceType === "string" ? { sourceType: payload.sourceType } : {}),
  };
}
