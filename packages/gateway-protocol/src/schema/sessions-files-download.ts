import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import {
  MAX_TERMINAL_UPLOAD_BASE64_LENGTH,
  MAX_TERMINAL_UPLOAD_BYTES,
} from "./terminal-constants.js";

/** Downloads one existing workspace file without changing the preview contract. */
export const SessionsFilesDownloadParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  agentId: Type.Optional(NonEmptyString),
});

export const SessionsFilesDownloadResultSchema = closedObject({
  sessionKey: NonEmptyString,
  file: closedObject({
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    size: Type.Integer({ minimum: 0, maximum: MAX_TERMINAL_UPLOAD_BYTES }),
    mimeType: Type.String({ minLength: 1, maxLength: 256 }),
    contentBase64: Type.String({ maxLength: MAX_TERMINAL_UPLOAD_BASE64_LENGTH }),
  }),
});

export type SessionsFilesDownloadParams = Static<typeof SessionsFilesDownloadParamsSchema>;
export type SessionsFilesDownloadResult = Static<typeof SessionsFilesDownloadResultSchema>;
