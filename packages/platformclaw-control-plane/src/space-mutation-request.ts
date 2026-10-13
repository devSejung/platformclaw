import { ControlPlaneStateError } from "./contracts.js";
import type { SpaceContentMutation } from "./space-content-contracts.js";

export function parseSpaceMutationRequest(
  body: Record<string, unknown>,
  route: "qa" | "notes",
): { proofId: string; payload: SpaceContentMutation } {
  const operation = body.operation;
  const fields =
    operation === "qa.append"
      ? ["body"]
      : operation === "note.append"
        ? ["text"]
        : ["oldText", "newText"];
  const allowed = new Set([
    "proofId",
    "operation",
    "spaceId",
    "pageId",
    "requestId",
    "expectedRevision",
    ...fields,
  ]);
  const invalid = () => {
    throw new ControlPlaneStateError("Invalid shared Space mutation");
  };
  if (
    (route === "qa"
      ? operation !== "qa.append"
      : operation !== "note.append" && operation !== "note.replace") ||
    Object.keys(body).some((key) => !allowed.has(key)) ||
    typeof body.proofId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(body.proofId) ||
    typeof body.requestId !== "string" ||
    !body.requestId.trim() ||
    body.requestId.length > 128 ||
    !Number.isSafeInteger(body.expectedRevision) ||
    (body.expectedRevision as number) < 1 ||
    ["spaceId", "pageId"].some(
      (key) =>
        body[key] !== undefined &&
        (typeof body[key] !== "string" ||
          !(body[key] as string).trim() ||
          (body[key] as string).length > 128),
    ) ||
    fields.some(
      (key) =>
        typeof body[key] !== "string" ||
        Buffer.byteLength(body[key] as string, "utf8") > 8192 ||
        (key !== "newText" && !(body[key] as string).trim()),
    )
  ) {
    invalid();
  }
  const common = {
    requestId: body.requestId as string,
    expectedRevision: body.expectedRevision as number,
    ...(body.spaceId === undefined ? {} : { spaceId: body.spaceId as string }),
    ...(body.pageId === undefined ? {} : { pageId: body.pageId as string }),
  };
  const payload: SpaceContentMutation =
    operation === "qa.append"
      ? { ...common, operation, body: body.body as string }
      : operation === "note.append"
        ? { ...common, operation, text: body.text as string }
        : {
            ...common,
            operation: "note.replace",
            oldText: body.oldText as string,
            newText: body.newText as string,
          };
  return { proofId: body.proofId as string, payload };
}
