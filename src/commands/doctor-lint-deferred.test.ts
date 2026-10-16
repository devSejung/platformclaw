import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctorLintCli } from "./doctor-lint.js";

const mocks = vi.hoisted(() => ({
  coreDetect: vi.fn(async () => []),
  pluginDetect: vi.fn(async () => []),
  registerBundledHealthChecks: vi.fn(),
  listExtensionHealthChecksForDoctor: vi.fn(),
  resolveDoctorContributionHealthChecks: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: vi.fn(async () => ({ exists: true, valid: true, config: {} })),
}));
vi.mock("../flows/bundled-health-checks.js", () => ({
  registerBundledHealthChecks: mocks.registerBundledHealthChecks,
}));
vi.mock("../flows/doctor-core-checks.js", () => ({
  configValidationIssuesToHealthFindings: vi.fn(() => []),
}));
vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: mocks.resolveDoctorContributionHealthChecks,
}));
vi.mock("../flows/health-check-registry.js", () => ({
  listExtensionHealthChecksForDoctor: mocks.listExtensionHealthChecksForDoctor,
  listHealthChecks: vi.fn(() => []),
}));

describe("doctor deferred lint boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
      {
        id: "core/doctor/deferred-fixture",
        kind: "core",
        description: "Deferred diagnostic",
        defaultEnabled: false,
        detect: mocks.coreDetect,
      },
    ]);
    mocks.listExtensionHealthChecksForDoctor.mockReturnValue([
      {
        id: "plugin/unknown",
        kind: "plugin",
        description: "Unclassified plugin",
        detect: mocks.pluginDetect,
      },
    ]);
  });

  it.each([false, true])(
    "bounds plugin execution while retaining full lint (deferred=%s)",
    async (deferredOnly) => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const code = await runDoctorLintCli(
          { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          {
            deferredOnly,
            includeAllChecks: !deferredOnly,
            json: true,
          },
        );
        expect(code).toBe(0);
        expect(mocks.coreDetect).toHaveBeenCalledOnce();
        expect(mocks.resolveDoctorContributionHealthChecks).toHaveBeenCalledWith({ deferredOnly });
        if (deferredOnly) {
          expect(mocks.registerBundledHealthChecks).not.toHaveBeenCalled();
          expect(mocks.listExtensionHealthChecksForDoctor).not.toHaveBeenCalled();
          expect(mocks.pluginDetect).not.toHaveBeenCalled();
        } else {
          expect(mocks.registerBundledHealthChecks).toHaveBeenCalledOnce();
          expect(mocks.pluginDetect).toHaveBeenCalledOnce();
        }
        expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
          ok: true,
          checksRun: deferredOnly ? 1 : 2,
        });
      } finally {
        stdout.mockRestore();
      }
    },
  );
});
