import { describe, expect, it } from "vitest";
import {
  parseCodingAgentConfiguration,
  parseCodingAgentProbeResult,
} from "./index.js";

const CLAUDE_ENVIRONMENT = {
  ANTHROPIC_BASE_URL: "https://gateway.example.test",
  ADMIN_API_URL: "https://admin.example.test",
  OIDC_ISSUER_URL: "https://identity.example.test",
  OIDC_CLIENT_ID: "claude-code",
};

const URL_WITH_FIXTURE_CREDENTIALS = new URL("https://admin.example.test");
URL_WITH_FIXTURE_CREDENTIALS.username = "fixture-user";

describe("coding agent contracts", () => {
  it("accepts complete enabled Claude gateway settings", () => {
    expect(
      parseCodingAgentConfiguration({
        agent: "claude",
        enabled: true,
        executablePath: "/home/person/.local/bin/claude",
        environment: CLAUDE_ENVIRONMENT,
      }),
    ).toMatchObject({ agent: "claude", enabled: true, environment: CLAUDE_ENVIRONMENT });
  });

  it("preserves incomplete values while disabled", () => {
    expect(
      parseCodingAgentConfiguration({
        agent: "claude",
        enabled: false,
        executablePath: "",
        environment: { ...CLAUDE_ENVIRONMENT, OIDC_CLIENT_ID: "" },
      }),
    ).toMatchObject({ enabled: false, environment: { OIDC_CLIENT_ID: "" } });
  });

  it.each([
    {
      field: "quoted value",
      environment: { ...CLAUDE_ENVIRONMENT, OIDC_CLIENT_ID: '"claude-code"' },
      message: "literal surrounding quotes",
    },
    {
      field: "embedded URL credentials",
      environment: {
        ...CLAUDE_ENVIRONMENT,
        ADMIN_API_URL: URL_WITH_FIXTURE_CREDENTIALS.href,
      },
      message: "without embedded credentials",
    },
    {
      field: "whitespace in client id",
      environment: { ...CLAUDE_ENVIRONMENT, OIDC_CLIENT_ID: "claude code" },
      message: "must not contain whitespace",
    },
  ])("rejects $field with actionable guidance", ({ environment, message }) => {
    expect(() =>
      parseCodingAgentConfiguration({
        agent: "claude",
        enabled: false,
        executablePath: "/usr/bin/claude",
        environment,
      }),
    ).toThrow(message);
  });

  it("rejects Claude-only and unknown fields on other agents", () => {
    expect(() =>
      parseCodingAgentConfiguration({
        agent: "codex",
        enabled: false,
        executablePath: "",
        environment: CLAUDE_ENVIRONMENT,
      }),
    ).toThrow("unsupported fields");
    expect(() =>
      parseCodingAgentConfiguration({
        agent: "opencode",
        enabled: false,
        executablePath: "",
        gatewayUrl: "https://invented.example.test",
      }),
    ).toThrow("unsupported fields");
  });

  it("keeps a malformed detected value in the preview with a diagnostic", () => {
    expect(
      parseCodingAgentProbeResult({
        agent: "claude",
        environment: { OIDC_CLIENT_ID: '"claude-code"' },
        diagnostics: [
          {
            stage: "helper",
            status: "failed",
            message: "OIDC_CLIENT_ID has literal surrounding quotes; remove them before saving",
          },
        ],
      }),
    ).toMatchObject({ environment: { OIDC_CLIENT_ID: '"claude-code"' } });
  });

  it("rejects duplicate diagnostic stages", () => {
    expect(() =>
      parseCodingAgentProbeResult({
        agent: "codex",
        diagnostics: [
          { stage: "executable", status: "passed", message: "found" },
          { stage: "executable", status: "passed", message: "still found" },
        ],
      }),
    ).toThrow("duplicate");
  });
});
