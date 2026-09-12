import { extractKeywords } from "@openclaw/memory-host-sdk/query";
import {
  createOrganizationKnowledgeAnalyzer,
  createOrganizationKnowledgePairCompletion,
  validateOrganizationKnowledgeAnalysisInput,
} from "@platformclaw/control-plane/organization-knowledge-analysis";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const ORGANIZATION_KNOWLEDGE_ANALYSIS_METHOD = "platformclaw.organization.knowledge.analyze";

export function registerOrganizationKnowledgeAnalysis(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    ORGANIZATION_KNOWLEDGE_ANALYSIS_METHOD,
    async ({ params, client, respond, signal }) => {
      // Only paired operator backend clients can carry a server-authorized frozen snapshot.
      // Browser employee routes cannot supply a model, agent, tools, or session authority.
      if (
        client?.connect.role !== "operator" ||
        !client.connect.scopes?.includes("operator.admin") ||
        client.connect.client.mode !== "backend" ||
        !client.connect.device?.id ||
        client.internal?.syntheticClient
      ) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message:
            "Organization knowledge analysis requires the paired control service operator connection.",
        });
        return;
      }
      try {
        const input = validateOrganizationKnowledgeAnalysisInput(params);
        const configured = api.config.agents?.defaults?.model;
        const model = typeof configured === "string" ? configured : configured?.primary;
        if (!model || !model.startsWith("company/")) {
          throw new Error(
            "Organization knowledge analysis is unavailable. Configure the existing company model as the default model and its provider-entry credential.",
          );
        }
        const completePair = createOrganizationKnowledgePairCompletion({
          model,
          complete: (request) => api.runtime.llm.completeWithProviderConfig(request),
        });
        const analyze = createOrganizationKnowledgeAnalyzer({ extractKeywords, completePair });
        const deadline = AbortSignal.timeout(240_000);
        const lifetime = signal ? AbortSignal.any([signal, deadline]) : deadline;
        respond(true, await analyze(input, lifetime));
      } catch {
        // Provider errors can contain endpoint or credential diagnostics; public failure stays redacted.
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message:
            "Organization knowledge analysis failed. Verify the configured company model, provider-entry credential, input bounds, and pinned citations; retry the scope.",
        });
      }
    },
    { scope: "operator.admin" },
  );
}
