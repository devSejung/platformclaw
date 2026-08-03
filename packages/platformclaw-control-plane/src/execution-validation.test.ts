import { describe, expect, it } from "vitest";
import { normalizeVmHostExecutionEnvironment } from "./execution-validation.js";

describe("VM host execution environment validation", () => {
  it("normalizes build paths and variables deterministically", () => {
    expect(
      normalizeVmHostExecutionEnvironment({
        pathPrepend: [" /opt/clang/bin/ ", "/opt/clang/bin", "/opt/gcc/bin"],
        variables: {
          TOOLCHAIN_PREFIX: " /opt/gcc/bin/aarch64-elf- ",
          CLANG11_PATH: "/opt/clang/bin/",
        },
      }),
    ).toEqual({
      pathPrepend: ["/opt/clang/bin", "/opt/gcc/bin"],
      variables: {
        CLANG11_PATH: "/opt/clang/bin/",
        TOOLCHAIN_PREFIX: "/opt/gcc/bin/aarch64-elf-",
      },
    });
  });

  it.each(["PATH", "HOME", "LD_PRELOAD", "BASH_ENV", "OPENCLAW_TOKEN"])(
    "rejects reserved or process-injection variable %s",
    (name) => {
      expect(() =>
        normalizeVmHostExecutionEnvironment({
          pathPrepend: [],
          variables: { [name]: "bad" },
        }),
      ).toThrow("not allowed");
    },
  );

  it("rejects non-canonical and relative PATH entries", () => {
    expect(() =>
      normalizeVmHostExecutionEnvironment({ pathPrepend: ["toolchain/bin"], variables: {} }),
    ).toThrow("absolute POSIX paths");
    expect(() =>
      normalizeVmHostExecutionEnvironment({ pathPrepend: ["/opt//bin"], variables: {} }),
    ).toThrow("absolute POSIX paths");
  });
});
