import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { SkillHubPublishArchive } from "./skill-hub-adapter.js";

export type SkillHubArtifactUpload = {
  namespace: string;
  expectedSkillId: number;
  archive: SkillHubPublishArchive;
  filename: string;
};
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;

/** Validate before login, but open the streamed artifact only at the upload effect. */
export function prepareSkillHubArtifactUpload(params: SkillHubArtifactUpload): () => RequestInit {
  const archiveSize = Buffer.isBuffer(params.archive)
    ? params.archive.byteLength
    : params.archive.size;
  if (
    !Number.isSafeInteger(archiveSize) ||
    archiveSize <= 0 ||
    archiveSize > MAX_ARCHIVE_BYTES ||
    !params.namespace ||
    /[\r\n]/u.test(params.namespace) ||
    !params.filename ||
    /["\\\r\n]/u.test(params.filename) ||
    !Number.isSafeInteger(params.expectedSkillId) ||
    params.expectedSkillId < 1
  ) {
    throw new Error("Invalid managed publication request");
  }
  const request = {
    namespace: params.namespace,
    expectedSkillId: params.expectedSkillId,
    filename: params.filename,
    archive: Buffer.isBuffer(params.archive) ? params.archive : { ...params.archive },
  };
  return () => publicationRequest(request);
}

function publicationRequest(params: SkillHubArtifactUpload): RequestInit {
  if (Buffer.isBuffer(params.archive)) {
    const form = new FormData();
    form.set("namespace", params.namespace);
    form.set("expectedSkillId", String(params.expectedSkillId));
    form.set("file", new Blob([new Uint8Array(params.archive)]), params.filename);
    return { method: "POST", body: form };
  }
  const archive = params.archive;
  const boundary = `platformclaw-${randomBytes(18).toString("hex")}`;
  const field = (name: string, value: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const prefix = Buffer.from(
    field("namespace", params.namespace) +
      field("expectedSkillId", String(params.expectedSkillId)) +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${params.filename}"\r\nContent-Type: application/zip\r\n\r\n`,
    "utf8",
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Readable.toWeb(
    Readable.from(
      (async function* () {
        yield prefix;
        let size = 0;
        for await (const chunk of createReadStream(archive.path)) {
          size += chunk.byteLength;
          if (size > archive.size) {
            throw new Error("Publication archive changed during upload");
          }
          yield chunk;
        }
        if (size !== archive.size) {
          throw new Error("Publication archive changed during upload");
        }
        yield suffix;
      })(),
    ),
  );
  return {
    method: "POST",
    body,
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(prefix.byteLength + archive.size + suffix.byteLength),
    },
    duplex: "half",
  } as RequestInit;
}
