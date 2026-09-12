import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as agentScope from "./agent-scope-config.js";
import * as authProfiles from "./auth-profiles/store.js";
import { prepareProviderConfigCompletionModel } from "./simple-completion-runtime.js";

const config = (): OpenClawConfig => ({
  agents: { entries: { employee: { default: true } }, defaults: { model: "company/dt-fixture" } },
  models: {
    providers: {
      company: {
        baseUrl: "http://127.0.0.1:19999/v1",
        api: "openai-completions",
        apiKey: "fixed-fixture-credential",
        models: [
          {
            id: "dt-fixture",
            name: "DT Fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 16_000,
            maxTokens: 2_500,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
});

describe("provider-config completion credential boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves configured transport/auth without default agent or auth-store access", () => {
    const store = vi.spyOn(authProfiles, "ensureAuthProfileStore").mockImplementation(() => {
      throw new Error("private store accessed");
    });
    const defaultAgent = vi.spyOn(agentScope, "resolveDefaultAgentDir").mockImplementation(() => {
      throw new Error("employee agent resolved");
    });
    const result = prepareProviderConfigCompletionModel({
      cfg: config(),
      provider: "company",
      modelId: "dt-fixture",
    });
    expect(result.model).toMatchObject({
      provider: "company",
      id: "dt-fixture",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:19999/v1",
    });
    expect(result.auth).toMatchObject({ source: "models.json", mode: "api-key" });
    expect(store).not.toHaveBeenCalled();
    expect(defaultAgent).not.toHaveBeenCalled();
  });

  it.each(["missing", "implicit-env", "profile-reference", "unknown-model"])(
    "fails closed for %s",
    (fault) => {
      const cfg = config();
      const provider = cfg.models!.providers!.company;
      if (fault === "missing") delete provider.apiKey;
      if (fault === "implicit-env") provider.apiKey = "OPENAI_API_KEY";
      if (fault === "profile-reference") {
        provider.apiKey = "employee-profile";
        cfg.auth = { profiles: { "employee-profile": { provider: "company", mode: "api_key" } } };
      }
      expect(() =>
        prepareProviderConfigCompletionModel({
          cfg,
          provider: "company",
          modelId: fault === "unknown-model" ? "unknown" : "dt-fixture",
        }),
      ).toThrow();
    },
  );
});
