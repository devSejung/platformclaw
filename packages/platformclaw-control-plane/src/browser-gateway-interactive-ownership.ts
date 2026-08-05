import type { BrowserGatewayEvent, BrowserGatewayRpc } from "./browser-gateway-contracts.js";

type JsonObject = Record<string, unknown>;

export type BrowserInteractiveAccess = {
  agentId: string;
  resolveAgentIdFromSessionKey(sessionKey: string): string | null;
};

type OwnerBinding = {
  agentId: string;
  sessionKey?: string;
};

type ApprovalBinding = OwnerBinding & {
  kind: string;
  allowedDecisions: ReadonlySet<string>;
};

export type BrowserInteractiveFailure = (
  code: "invalid-params" | "cross-agent-denied" | "upstream-result-denied",
  message: string,
) => never;

export type BrowserInteractiveRequestResult =
  | { handled: false }
  | { handled: true; result: unknown };

const MAX_OWNERSHIP_BINDINGS = 4_096;

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bindBounded<T>(registry: Map<string, T>, id: string, binding: T): void {
  registry.delete(id);
  registry.set(id, binding);
  while (registry.size > MAX_OWNERSHIP_BINDINGS) {
    const oldest = registry.keys().next().value as string | undefined;
    if (!oldest) {
      return;
    }
    registry.delete(oldest);
  }
}

function ownerFromRecord(
  access: BrowserInteractiveAccess,
  record: JsonObject,
): OwnerBinding | null {
  const declaredAgentId = nonEmptyString(record.agentId);
  const sessionKey = nonEmptyString(record.sessionKey);
  const sessionAgentId = sessionKey ? access.resolveAgentIdFromSessionKey(sessionKey) : null;
  if (sessionKey && !sessionAgentId) {
    return null;
  }
  if (declaredAgentId && sessionAgentId && declaredAgentId !== sessionAgentId) {
    return null;
  }
  const agentId = declaredAgentId ?? sessionAgentId ?? undefined;
  return agentId ? { agentId, ...(sessionKey ? { sessionKey } : {}) } : null;
}

function bindingBelongsToAccess(access: BrowserInteractiveAccess, binding: OwnerBinding): boolean {
  return (
    binding.agentId === access.agentId &&
    (!binding.sessionKey ||
      access.resolveAgentIdFromSessionKey(binding.sessionKey) === access.agentId)
  );
}

function projectSessionApproval(approval: JsonObject): JsonObject | null {
  const presentation = asRecord(approval.presentation);
  if (!presentation || !Array.isArray(presentation.allowedDecisions)) {
    return null;
  }
  // Persistent host policy is outside one user's session boundary.
  const allowedDecisions = presentation.allowedDecisions.filter(
    (decision) => decision === "allow-once" || decision === "deny",
  );
  return allowedDecisions.length > 0
    ? { ...approval, presentation: { ...presentation, allowedDecisions } }
    : null;
}

/** Owns transient ids whose terminal events intentionally omit session identity. */
export class BrowserGatewayInteractiveOwnership {
  private readonly questionOwners = new Map<string, OwnerBinding>();
  private readonly taskSuggestionOwners = new Map<string, OwnerBinding>();
  private readonly approvalOwners = new Map<string, ApprovalBinding>();

  constructor(
    private readonly gateway: BrowserGatewayRpc,
    private readonly fail: BrowserInteractiveFailure,
  ) {}

  async request(
    access: BrowserInteractiveAccess,
    method: string,
    params: JsonObject,
  ): Promise<BrowserInteractiveRequestResult> {
    if (method === "question.list") {
      const result = await this.gateway.request(method, {});
      return { handled: true, result: this.projectQuestionList(access, result) };
    }
    if (method === "question.get") {
      const id = this.requireId(params.id, method);
      const result = await this.gateway.request(method, { id });
      return { handled: true, result: this.projectQuestionGet(access, result) };
    }
    if (method === "question.resolve") {
      const id = this.requireId(params.id, method);
      const current = await this.gateway.request("question.get", { id });
      this.projectQuestionGet(access, current);
      const request = { id } as JsonObject;
      if (params.cancel === true) {
        request.cancel = true;
      } else if (asRecord(params.answers)) {
        request.answers = params.answers;
      } else {
        this.fail("invalid-params", "question.resolve requires answers or cancel=true");
      }
      return { handled: true, result: await this.gateway.request(method, request) };
    }
    if (method === "taskSuggestions.list") {
      const sessionKey = nonEmptyString(params.sessionKey);
      if (sessionKey && access.resolveAgentIdFromSessionKey(sessionKey) !== access.agentId) {
        this.fail("cross-agent-denied", "task suggestion session is not owned by browser agent");
      }
      const result = await this.gateway.request(method, {
        agentId: access.agentId,
        ...(sessionKey ? { sessionKey } : {}),
      });
      return { handled: true, result: this.projectTaskSuggestionList(access, result) };
    }
    if (method === "taskSuggestions.accept" || method === "taskSuggestions.dismiss") {
      const taskId = this.requireId(params.taskId, method);
      await this.ensureTaskSuggestionOwner(access, taskId);
      const result = await this.gateway.request(method, {
        taskId,
        ...(method === "taskSuggestions.dismiss" && typeof params.reason === "string"
          ? { reason: params.reason }
          : {}),
      });
      if (method === "taskSuggestions.accept") {
        const record = asRecord(result);
        const key = nonEmptyString(record?.key);
        if (!record || !key || access.resolveAgentIdFromSessionKey(key) !== access.agentId) {
          this.fail("upstream-result-denied", "Gateway returned a foreign suggested-task session");
        }
      }
      return { handled: true, result };
    }
    if (method === "approval.get") {
      const id = this.requireId(params.id, method);
      const binding = this.approvalOwners.get(id);
      if (!binding || !bindingBelongsToAccess(access, binding)) {
        this.fail("cross-agent-denied", "approval is not bound to the browser agent");
      }
      const result = asRecord(await this.gateway.request(method, { id }));
      const approval = asRecord(result?.approval);
      const projected = approval ? projectSessionApproval(approval) : null;
      const presentation = projected ? asRecord(projected.presentation) : null;
      if (
        !result ||
        !projected ||
        nonEmptyString(projected.id) !== id ||
        nonEmptyString(presentation?.kind) !== binding.kind
      ) {
        this.fail("upstream-result-denied", "Gateway returned a mismatched approval record");
      }
      return { handled: true, result: { approval: projected } };
    }
    if (method === "approval.resolve") {
      const id = this.requireId(params.id, method);
      const binding = this.approvalOwners.get(id);
      const kind = nonEmptyString(params.kind);
      const decision = nonEmptyString(params.decision);
      if (!binding || !bindingBelongsToAccess(access, binding)) {
        this.fail("cross-agent-denied", "approval is not bound to the browser agent");
      }
      if (!kind || kind !== binding.kind || !decision || !binding.allowedDecisions.has(decision)) {
        this.fail("invalid-params", "approval kind or decision does not match the session prompt");
      }
      const result = asRecord(await this.gateway.request(method, { id, kind, decision }));
      const approval = asRecord(result?.approval);
      const projected = approval ? projectSessionApproval(approval) : null;
      return {
        handled: true,
        result: result && projected ? { ...result, approval: projected } : result,
      };
    }
    return { handled: false };
  }

  filterEvent(
    access: BrowserInteractiveAccess,
    event: BrowserGatewayEvent,
  ): BrowserGatewayEvent | null | undefined {
    if (event.event === "question.requested") {
      const record = asRecord(event.payload);
      return record && this.bindQuestion(access, record) ? event : null;
    }
    if (event.event === "question.resolved") {
      return this.boundEventBelongsToAccess(access, event.payload, this.questionOwners)
        ? event
        : null;
    }
    if (event.event === "task.suggestion") {
      const payload = asRecord(event.payload);
      if (!payload) {
        return null;
      }
      if (payload.action === "created") {
        const suggestion = asRecord(payload.suggestion);
        return suggestion && this.bindTaskSuggestion(access, suggestion) ? event : null;
      }
      if (payload.action === "resolved") {
        return this.boundEventBelongsToAccess(
          access,
          { id: payload.taskId },
          this.taskSuggestionOwners,
        )
          ? event
          : null;
      }
      return null;
    }
    if (event.event === "session.approval") {
      const payload = asRecord(event.payload);
      const approval = payload ? asRecord(payload.approval) : null;
      const projected = approval ? projectSessionApproval(approval) : null;
      const projectedPayload = payload && projected ? { ...payload, approval: projected } : null;
      return projectedPayload && this.bindSessionApproval(access, projectedPayload)
        ? { ...event, payload: projectedPayload }
        : null;
    }
    return undefined;
  }

  projectApprovalReplay(access: BrowserInteractiveAccess, value: unknown): unknown {
    const replay = asRecord(value);
    const sessionKey = nonEmptyString(replay?.sessionKey);
    if (
      !replay ||
      !sessionKey ||
      access.resolveAgentIdFromSessionKey(sessionKey) !== access.agentId
    ) {
      this.fail("upstream-result-denied", "Gateway returned a foreign approval replay");
    }
    if (!Array.isArray(replay.approvals)) {
      this.fail("upstream-result-denied", "Gateway returned an invalid approval replay");
    }
    const approvals = replay.approvals.flatMap((approval) => {
      const record = asRecord(approval);
      const projected = record ? projectSessionApproval(record) : null;
      return projected && this.bindApproval(access, sessionKey, projected) ? [projected] : [];
    });
    return { ...replay, approvals };
  }

  private projectQuestionList(access: BrowserInteractiveAccess, value: unknown): unknown {
    const result = asRecord(value);
    if (!result || !Array.isArray(result.questions)) {
      this.fail("upstream-result-denied", "Gateway returned an invalid question list");
    }
    const questions = result.questions.filter((question) => {
      const record = asRecord(question);
      if (!record || !nonEmptyString(record.id)) {
        this.fail("upstream-result-denied", "Gateway returned an invalid question record");
      }
      return this.bindQuestion(access, record);
    });
    return { questions };
  }

  private projectQuestionGet(access: BrowserInteractiveAccess, value: unknown): unknown {
    const result = asRecord(value);
    const question = asRecord(result?.question);
    if (!result || !question || !this.bindQuestion(access, question)) {
      this.fail("cross-agent-denied", "question is not owned by browser agent");
    }
    return { question };
  }

  private projectTaskSuggestionList(access: BrowserInteractiveAccess, value: unknown): unknown {
    const result = asRecord(value);
    if (!result || !Array.isArray(result.suggestions)) {
      this.fail("upstream-result-denied", "Gateway returned an invalid task suggestion list");
    }
    const suggestions = result.suggestions.filter((suggestion) => {
      const record = asRecord(suggestion);
      if (!record || !nonEmptyString(record.id)) {
        this.fail("upstream-result-denied", "Gateway returned an invalid task suggestion");
      }
      return this.bindTaskSuggestion(access, record);
    });
    return { suggestions };
  }

  private async ensureTaskSuggestionOwner(
    access: BrowserInteractiveAccess,
    taskId: string,
  ): Promise<void> {
    const existing = this.taskSuggestionOwners.get(taskId);
    if (existing && bindingBelongsToAccess(access, existing)) {
      return;
    }
    const listed = this.projectTaskSuggestionList(
      access,
      await this.gateway.request("taskSuggestions.list", { agentId: access.agentId }),
    ) as { suggestions: JsonObject[] };
    if (!listed.suggestions.some((suggestion) => suggestion.id === taskId)) {
      this.fail("cross-agent-denied", "task suggestion is not owned by browser agent");
    }
  }

  private bindQuestion(access: BrowserInteractiveAccess, record: JsonObject): boolean {
    const id = nonEmptyString(record.id);
    const owner = ownerFromRecord(access, record);
    if (!id || !owner || !bindingBelongsToAccess(access, owner)) {
      return false;
    }
    bindBounded(this.questionOwners, id, owner);
    return true;
  }

  private bindTaskSuggestion(access: BrowserInteractiveAccess, record: JsonObject): boolean {
    const id = nonEmptyString(record.id);
    const owner = ownerFromRecord(access, record);
    if (!id || !owner || !owner.sessionKey || !bindingBelongsToAccess(access, owner)) {
      return false;
    }
    bindBounded(this.taskSuggestionOwners, id, owner);
    return true;
  }

  private bindSessionApproval(access: BrowserInteractiveAccess, payload: JsonObject): boolean {
    const sessionKey = nonEmptyString(payload.sessionKey);
    const approval = asRecord(payload.approval);
    return Boolean(
      sessionKey &&
      approval &&
      access.resolveAgentIdFromSessionKey(sessionKey) === access.agentId &&
      this.bindApproval(access, sessionKey, approval),
    );
  }

  private bindApproval(
    access: BrowserInteractiveAccess,
    sessionKey: string,
    approval: JsonObject,
  ): boolean {
    const id = nonEmptyString(approval.id);
    const presentation = asRecord(approval.presentation);
    const kind = nonEmptyString(presentation?.kind);
    const presentationAgentId = nonEmptyString(presentation?.agentId);
    const allowedDecisions = Array.isArray(presentation?.allowedDecisions)
      ? presentation.allowedDecisions
          .map(nonEmptyString)
          .filter((value): value is string => !!value)
      : [];
    if (
      !id ||
      !kind ||
      allowedDecisions.length === 0 ||
      access.resolveAgentIdFromSessionKey(sessionKey) !== access.agentId ||
      (presentationAgentId && presentationAgentId !== access.agentId)
    ) {
      return false;
    }
    bindBounded(this.approvalOwners, id, {
      agentId: access.agentId,
      sessionKey,
      kind,
      allowedDecisions: new Set(allowedDecisions),
    });
    return true;
  }

  private boundEventBelongsToAccess(
    access: BrowserInteractiveAccess,
    payload: unknown,
    registry: ReadonlyMap<string, OwnerBinding>,
  ): boolean {
    const id = nonEmptyString(asRecord(payload)?.id);
    const binding = id ? registry.get(id) : undefined;
    return Boolean(binding && bindingBelongsToAccess(access, binding));
  }

  private requireId(value: unknown, method: string): string {
    const id = nonEmptyString(value);
    return id ?? this.fail("invalid-params", `${method} requires an id`);
  }
}
