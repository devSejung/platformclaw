import {
  isCodingAgentId,
  parseCodingAgentConfiguration,
  type CodingAgentConfiguration,
  type CodingAgentId,
} from "@platformclaw/coding-agent-contract";

type CodingAgentRouteService = {
  detectCodingAgent(params: {
    userId: string;
    agentId: string;
    agent: CodingAgentId;
    expectedRevision: number;
  }): Promise<unknown>;
  checkCodingAgent(params: {
    userId: string;
    agentId: string;
    configuration: CodingAgentConfiguration;
    expectedRevision: number;
  }): Promise<unknown>;
  saveCodingAgent(params: {
    userId: string;
    agentId: string;
    configuration: CodingAgentConfiguration;
    expectedRevision: number;
  }): Promise<unknown>;
};

type CodingAgentRouteResult = { status: 200 | 400; body: unknown };

export async function handleCodingAgentRouteOperation(params: {
  service: CodingAgentRouteService;
  body: Record<string, unknown>;
  userId: string;
  agentId: string;
}): Promise<CodingAgentRouteResult> {
  const { action, expectedRevision } = params.body;
  if (
    (action !== "detect" && action !== "check" && action !== "save") ||
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return { status: 400, body: { error: "invalid coding agent operation" } };
  }
  const owner = { userId: params.userId, agentId: params.agentId, expectedRevision };
  if (action === "detect") {
    if (!isCodingAgentId(params.body.agent)) {
      return { status: 400, body: { error: "invalid coding agent detection" } };
    }
    return {
      status: 200,
      body: await params.service.detectCodingAgent({ ...owner, agent: params.body.agent }),
    };
  }
  let configuration: CodingAgentConfiguration;
  try {
    configuration = parseCodingAgentConfiguration(params.body.configuration);
  } catch (error) {
    return {
      status: 400,
      body: {
        error: error instanceof Error ? error.message : "invalid coding agent configuration",
      },
    };
  }
  return {
    status: 200,
    body:
      action === "save"
        ? await params.service.saveCodingAgent({ ...owner, configuration })
        : await params.service.checkCodingAgent({ ...owner, configuration }),
  };
}
