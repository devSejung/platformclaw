// Sandbox backend registry tests cover pluggable backend factory and manager
// lifecycle hooks.
import { describe, expect, it } from "vitest";
import {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendSkillMaterializationMode,
  getSandboxBackendSkillProvider,
  getSandboxBackendWorkdirResolver,
  registerSandboxBackend,
} from "./backend.js";

describe("sandbox backend registry", () => {
  it("registers Podman as a built-in backend", () => {
    expect(getSandboxBackendFactory("podman")).not.toBeNull();
    expect(getSandboxBackendManager("podman")).not.toBeNull();
    expect(getSandboxBackendWorkdirResolver("podman")).not.toBeNull();
  });

  it("registers and restores backend factories", () => {
    // Tests and optional backends install process-local factories; restore must
    // remove them so later suites see the default registry.
    const factory = async () => {
      throw new Error("not used");
    };
    const restore = registerSandboxBackend("test-backend", factory);
    expect(getSandboxBackendFactory("test-backend")).toBe(factory);
    restore();
    expect(getSandboxBackendFactory("test-backend")).toBeNull();
  });

  it("registers backend managers alongside factories", () => {
    const factory = async () => {
      throw new Error("not used");
    };
    const manager = {
      describeRuntime: async () => ({
        running: true,
        configLabelMatch: true,
      }),
      removeRuntime: async () => {},
    };
    const restore = registerSandboxBackend("test-managed", {
      factory,
      manager,
    });
    expect(getSandboxBackendFactory("test-managed")).toBe(factory);
    expect(getSandboxBackendManager("test-managed")).toBe(manager);
    restore();
    expect(getSandboxBackendManager("test-managed")).toBeNull();
  });

  it("registers backend workdir resolvers alongside factories", () => {
    const factory = async () => {
      throw new Error("not used");
    };
    const resolveWorkdir = () => "/runtime/workspace";
    const restore = registerSandboxBackend("test-workdir", {
      factory,
      resolveWorkdir,
    });
    expect(getSandboxBackendWorkdirResolver("test-workdir")).toBe(resolveWorkdir);
    restore();
    expect(getSandboxBackendWorkdirResolver("test-workdir")).toBeNull();
  });

  it("registers target-owned skill providers alongside factories", () => {
    const factory = async () => {
      throw new Error("not used");
    };
    const skills = async () => undefined;
    const restore = registerSandboxBackend("test-skills", { factory, skills });
    expect(getSandboxBackendSkillProvider("test-skills")).toBe(skills);
    restore();
    expect(getSandboxBackendSkillProvider("test-skills")).toBeNull();
  });

  it("registers deferred skill materialization as an opt-in backend contract", () => {
    const factory = async () => {
      throw new Error("not used");
    };
    const restore = registerSandboxBackend("test-deferred-skills", {
      factory,
      skillMaterialization: "backend-deferred",
    });

    expect(getSandboxBackendSkillMaterializationMode("test-deferred-skills")).toBe(
      "backend-deferred",
    );
    restore();
    expect(getSandboxBackendSkillMaterializationMode("test-deferred-skills")).toBeNull();
  });
});
