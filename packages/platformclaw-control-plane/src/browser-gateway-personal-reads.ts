import {
  prepareBrowserApprovalHistoryRequest,
  projectBrowserApprovalHistoryResult,
} from "./browser-gateway-approval-history.js";
import {
  prepareBrowserMemoryRequest,
  projectBrowserMemoryResult,
} from "./browser-gateway-memory.js";

type JsonObject = Record<string, unknown>;
type ProjectionFailure = (message: string) => never;

export function prepareBrowserPersonalReadRequest(params: {
  method: string;
  request: JsonObject;
  agentId: string;
  assertOptionalAgentId(value: unknown, label: string): void;
  fail: ProjectionFailure;
}): JsonObject | undefined {
  return prepareBrowserApprovalHistoryRequest(params) ?? prepareBrowserMemoryRequest(params);
}

export function projectBrowserPersonalReadResult(params: {
  method: string;
  request: JsonObject;
  result: unknown;
  agentId: string;
  fail: ProjectionFailure;
}): JsonObject | undefined {
  return projectBrowserApprovalHistoryResult(params) ?? projectBrowserMemoryResult(params);
}
