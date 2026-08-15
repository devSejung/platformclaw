import {
  isWellFormedApprovalId,
  validateApprovalHistoryResult,
  type ApprovalHistoryResult,
  type ApprovalPresentation,
  type TerminalApprovalSnapshot,
} from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

type JsonObject = Record<string, unknown>;
type ProjectionFailure = (message: string) => never;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_CHARS = 512;
const APPROVAL_KINDS = new Set(["exec", "plugin", "system-agent"]);

function readCursor(value: unknown): { resolvedAtMs: number; id: string } | null {
  if (typeof value !== "string" || !value || value.length > MAX_CURSOR_CHARS) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return isRecord(parsed) &&
      parsed.v === 1 &&
      typeof parsed.resolvedAtMs === "number" &&
      Number.isSafeInteger(parsed.resolvedAtMs) &&
      parsed.resolvedAtMs >= 0 &&
      typeof parsed.id === "string" &&
      isWellFormedApprovalId(parsed.id)
      ? { resolvedAtMs: parsed.resolvedAtMs, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

function projectPresentation(presentation: ApprovalPresentation): ApprovalPresentation {
  switch (presentation.kind) {
    case "exec":
      return {
        kind: "exec",
        commandText: presentation.commandText,
        allowedDecisions: presentation.allowedDecisions,
      };
    case "plugin":
      return {
        kind: "plugin",
        title: presentation.title,
        description: presentation.description,
        severity: presentation.severity,
        allowedDecisions: presentation.allowedDecisions,
      };
    case "system-agent":
      return {
        kind: "system-agent",
        title: presentation.title,
        description: presentation.description,
        proposalHash: presentation.proposalHash,
        allowedDecisions: presentation.allowedDecisions,
      };
  }
  return presentation satisfies never;
}

function projectItem(item: TerminalApprovalSnapshot, agentId: string): TerminalApprovalSnapshot {
  return {
    ...item,
    urlPath: `/approve/${encodeURIComponent(item.id)}`,
    presentation: projectPresentation(item.presentation),
    source: { agentId },
    ...(item.resolver ? { resolver: { kind: item.resolver.kind } } : {}),
  };
}

export function prepareBrowserApprovalHistoryRequest(params: {
  method: string;
  request: JsonObject;
  agentId: string;
  assertOptionalAgentId(value: unknown, label: string): void;
  fail: ProjectionFailure;
}): JsonObject | undefined {
  if (params.method !== "approval.history") {
    return undefined;
  }
  params.assertOptionalAgentId(params.request.agentId, params.method);
  const limit = params.request.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_PAGE_SIZE) {
    return params.fail(`approval history limit must be an integer from 1-${MAX_PAGE_SIZE}`);
  }
  const kind = params.request.kind;
  if (kind !== undefined && (typeof kind !== "string" || !APPROVAL_KINDS.has(kind))) {
    return params.fail("approval history kind is invalid");
  }
  const cursor = params.request.cursor;
  if (cursor !== undefined && !readCursor(cursor)) {
    return params.fail("approval history cursor is invalid");
  }
  return {
    agentId: params.agentId,
    limit,
    ...(kind ? { kind } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export function projectBrowserApprovalHistoryResult(params: {
  method: string;
  request: JsonObject;
  result: unknown;
  agentId: string;
  fail: ProjectionFailure;
}): ApprovalHistoryResult | undefined {
  if (params.method !== "approval.history") {
    return undefined;
  }
  if (!validateApprovalHistoryResult(params.result)) {
    return params.fail("Gateway returned invalid approval history");
  }
  const result = params.result as ApprovalHistoryResult;
  const limit = params.request.limit as number;
  if (result.items.length > limit) {
    return params.fail("Gateway returned too many approval history items");
  }
  for (const item of result.items) {
    if (
      item.source?.agentId !== params.agentId ||
      (item.presentation.agentId !== undefined && item.presentation.agentId !== params.agentId)
    ) {
      return params.fail("Gateway returned approval history outside the browser binding");
    }
  }
  if (result.nextCursor) {
    // The Gateway cursor must identify the last already-verified row; otherwise its opaque payload
    // could disclose a foreign approval id or skip across another Agent's ledger position.
    const cursor = readCursor(result.nextCursor);
    const last = result.items.at(-1);
    if (!cursor || !last || cursor.id !== last.id || cursor.resolvedAtMs !== last.resolvedAtMs) {
      return params.fail("Gateway returned a mismatched approval history cursor");
    }
  }
  return {
    items: result.items.map((item) => projectItem(item, params.agentId)),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}
