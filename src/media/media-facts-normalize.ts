// Persisted attachment normalization is shared with Control UI. Keep this module
// free of filesystem access and byte sniffing so browser consumers can load it.
import { kindFromMime, type MediaKind, normalizeMimeType } from "@openclaw/media-core/constants";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** One ordered runtime attachment; array position is its alignment identity. */
export type MediaFact = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: MediaKind;
  fileName?: string;
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
  transcribed?: boolean;
  messageId?: string;
  workspaceDir?: string;
  /** Internal proof that this exact fact was covered by a legacy staged projection. */
  staged?: boolean;
  // Declared field, not a symbol: suppression must survive every fact copy or
  // reprojection boundary; described images otherwise rehydrate or count failed.
  // Structured persistence may retain it; legacy Media* projections never emit it.
  hydrationSuppressed?: boolean;
};

export type MediaFactInput = {
  [Key in keyof MediaFact]?: MediaFact[Key] | null;
};

function normalizeNonNegativeNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Reads the canonical persisted media envelope without consulting legacy top-level fields. */
export function readPersistedMediaFacts(message: object): MediaFact[] | undefined {
  const media = readPersistedMediaFactInputs(message);
  return media ? normalizeMediaFacts(media) : undefined;
}

export function readPersistedMediaFactInputs(message: object): MediaFactInput[] | undefined {
  const metadata = (message as Record<string, unknown>)["__openclaw"];
  const media =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).media
      : undefined;
  return Array.isArray(media) ? (media as MediaFactInput[]) : undefined;
}

/** Returns whether a declared MIME only describes otherwise unclassified binary bytes. */
export function isGenericBinaryMediaContentType(contentType?: string | null): boolean {
  const normalizedContentType = normalizeMimeType(contentType);
  return (
    normalizedContentType === "application/octet-stream" ||
    normalizedContentType === "binary/octet-stream"
  );
}

type MediaFactDefaults<TInput extends MediaFactInput = MediaFactInput> = {
  kind?: MediaKind;
  messageId?: string;
  workspaceDir?: string;
  transcribed?: (media: TInput, index: number) => boolean;
};

function normalizePositiveInteger(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function normalizeMediaFact<TInput extends MediaFactInput>(
  media: TInput,
  index: number,
  defaults: MediaFactDefaults<TInput> = {},
): MediaFact {
  const workspaceDir = normalizeOptionalString(media.workspaceDir) ?? defaults.workspaceDir;
  const contentType = normalizeOptionalString(media.contentType);
  const durationMs = normalizePositiveInteger(media.durationMs);
  const width = normalizePositiveInteger(media.width);
  const height = normalizePositiveInteger(media.height);
  const normalized: MediaFact = {
    path: normalizeOptionalString(media.path),
    url: normalizeOptionalString(media.url),
    contentType,
    kind:
      media.kind ??
      defaults.kind ??
      (isGenericBinaryMediaContentType(contentType) ? undefined : kindFromMime(contentType)),
    fileName: normalizeOptionalString(media.fileName),
    sizeBytes: normalizeNonNegativeNumber(media.sizeBytes),
    ...(durationMs ? { durationMs } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    transcribed: media.transcribed === true || defaults.transcribed?.(media, index) === true,
    messageId: normalizeOptionalString(media.messageId) ?? defaults.messageId,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(media.staged === true ? { staged: true } : {}),
    ...(media.hydrationSuppressed === true ? { hydrationSuppressed: true } : {}),
  };
  return normalized;
}

export function normalizeMediaFacts<TInput extends MediaFactInput>(
  media: readonly TInput[] | null | undefined,
  defaults: MediaFactDefaults<TInput> = {},
): MediaFact[] {
  return Array.isArray(media)
    ? media.map((entry, index) => normalizeMediaFact(entry, index, defaults))
    : [];
}

// Empty slots exist only to keep legacy parallel-array positions aligned;
// presence/counting sites must ignore them or blank projections ({MediaPaths: [""]})
// route media-less messages into inbound-media handling.
export function isMeaningfulMediaFact(fact: MediaFact): boolean {
  return Boolean(
    fact.path?.trim() ||
    fact.url?.trim() ||
    fact.contentType ||
    (fact.kind && fact.kind !== "unknown"),
  );
}
