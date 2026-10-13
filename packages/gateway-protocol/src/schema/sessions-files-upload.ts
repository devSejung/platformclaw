import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import {
  MAX_TERMINAL_UPLOAD_BASE64_LENGTH,
  MAX_TERMINAL_UPLOAD_BYTES,
  MAX_TERMINAL_UPLOAD_NAME_LENGTH,
} from "./terminal-constants.js";

/** Creates one file in an existing local session workspace folder, without replacing files. */
export const SessionsFilesUploadParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  path: Type.String({ maxLength: 4096 }),
  name: Type.String({ minLength: 1, maxLength: MAX_TERMINAL_UPLOAD_NAME_LENGTH }),
  contentBase64: Type.String({ maxLength: MAX_TERMINAL_UPLOAD_BASE64_LENGTH }),
});

export const SessionsFilesUploadResultSchema = closedObject({
  sessionKey: NonEmptyString,
  path: NonEmptyString,
  size: Type.Integer({ minimum: 0, maximum: MAX_TERMINAL_UPLOAD_BYTES }),
});

export type SessionsFilesUploadParams = Static<typeof SessionsFilesUploadParamsSchema>;
export type SessionsFilesUploadResult = Static<typeof SessionsFilesUploadResultSchema>;
