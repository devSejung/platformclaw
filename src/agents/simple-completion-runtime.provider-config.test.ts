import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../secrets/sentinel.js";
import { prepareProviderConfigCompletionModel } from "./simple-completion-runtime.js";

function createProviderConfig(apiKey: string): OpenClawConfig {
  return {
    models: {
      providers: {
        company: {
          api: "openai-responses",
          baseUrl: "https://company.example.test/v1",
          apiKey,
          models: [{ id: "dt-fixture", name: "DT Fixture" }],
        },
      },
    },
  } as OpenClawConfig;
}

describe("prepareProviderConfigCompletionModel", () => {
  it("uses only the explicit provider-entry credential", () => {
    const prepared = prepareProviderConfigCompletionModel({
      cfg: createProviderConfig("company-service-key"),
      provider: "company",
      modelId: "dt-fixture",
    });

    expect(prepared.model).toMatchObject({
      provider: "company",
      id: "dt-fixture",
      baseUrl: "https://company.example.test/v1",
    });
    expect(prepared.auth).toMatchObject({ source: "models.json", mode: "api-key" });
    expect(looksLikeSecretSentinel(prepared.auth.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(prepared.auth.apiKey ?? "")).toBe("company-service-key");
  });

  it("rejects a provider-entry reference to an employee auth profile", () => {
    const cfg = createProviderConfig("company:employee");
    cfg.auth = {
      profiles: {
        "company:employee": {
          provider: "company",
          mode: "api_key",
        },
      },
    } as OpenClawConfig["auth"];

    expect(() =>
      prepareProviderConfigCompletionModel({
        cfg,
        provider: "company",
        modelId: "dt-fixture",
      }),
    ).toThrow("stored profile references");
  });
});
