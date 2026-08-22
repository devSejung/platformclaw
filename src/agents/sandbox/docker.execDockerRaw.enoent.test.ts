// Docker command tests cover actionable errors when sandbox mode cannot find
// the docker executable.
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { execDockerRaw } from "./docker.js";

describe("execDockerRaw", () => {
  it("wraps docker ENOENT with an actionable configuration error", async () => {
    // ENOENT otherwise looks like a low-level spawn failure; operators need the
    // sandbox config remediation in the error text.
    await withTempDir("openclaw-missing-docker-", async (emptyPath) => {
      await withEnvAsync({ PATH: emptyPath }, async () => {
        let err: unknown;
        try {
          await execDockerRaw(["version"]);
        } catch (caught) {
          err = caught;
        }

        expect(err).toBeInstanceOf(Error);
        const error = err as Error & { code?: string };
        expect(error.code).toBe("INVALID_CONFIG");
        expect(error.message).toBe(
          'Sandbox mode requires Docker, but the "docker" command was not found in PATH. Install Docker (and ensure "docker" is available), or set `agents.defaults.sandbox.mode=off` to disable sandboxing.',
        );
      });
    });
  });
});
