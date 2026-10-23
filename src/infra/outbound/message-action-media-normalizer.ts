import { assertMediaNotDataUrl, resolveSandboxedMediaSource } from "../../agents/sandbox-paths.js";
import type { SandboxOutboundFileAccess } from "../../agents/sandbox/outbound-file-access.js";
import { resolveOutboundAttachmentFromRuntime } from "../../media/outbound-attachment.js";
import { MEDIA_MAX_BYTES } from "../../media/store.js";

// Internal buffer reference retained for Gateway-owned delivery; never a file path.
export const MESSAGE_SEND_BUFFER_MEDIA_URL = "buffer://message-send/attachment";

export type SandboxMediaNormalizationOptions = {
  sandboxRoot?: string;
  sandboxOutboundFileAccess?: SandboxOutboundFileAccess;
  maxBytes?: number;
  signal?: AbortSignal;
  dryRun?: boolean;
};

export function createSandboxMediaNormalizer(params: SandboxMediaNormalizationOptions) {
  const sandboxRoot = params.sandboxRoot?.trim();
  const fileAccess = params.sandboxOutboundFileAccess;
  const staged = new Map<string, Promise<string>>();
  return async (source: string): Promise<string> => {
    assertMediaNotDataUrl(source);
    if (source.trim() === MESSAGE_SEND_BUFFER_MEDIA_URL) {
      return MESSAGE_SEND_BUFFER_MEDIA_URL;
    }
    if (fileAccess) {
      if (params.dryRun) {
        return source.trim();
      }
      // Several aliases can name the same runtime file. Read that source once,
      // then replace every occurrence before the send payload is normalized again.
      const key = source.trim();
      let pending = staged.get(key);
      if (!pending) {
        pending = resolveOutboundAttachmentFromRuntime(key, params.maxBytes ?? MEDIA_MAX_BYTES, {
          fileAccess,
          signal: params.signal,
        }).then((attachment) => attachment.path);
        staged.set(key, pending);
      }
      return await pending;
    }
    return sandboxRoot ? await resolveSandboxedMediaSource({ media: source, sandboxRoot }) : source;
  };
}

/** Normalizes a list of media hints against an optional sandbox root. */
export async function normalizeSandboxMediaList(
  params: {
    values: string[];
  } & SandboxMediaNormalizationOptions,
): Promise<string[]> {
  const normalize = createSandboxMediaNormalizer(params);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of params.values) {
    const raw = value?.trim();
    if (!raw) {
      continue;
    }
    const resolved = await normalize(raw);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}
