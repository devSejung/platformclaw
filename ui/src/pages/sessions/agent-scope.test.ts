import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { sessionAgentIds } from "./agent-scope.ts";

describe("sessionAgentIds", () => {
  it("deduplicates canonical agent ids and ignores non-agent keys", () => {
    expect(
      sessionAgentIds({
        sessions: [
          { key: "agent:main:one" },
          { key: "agent:main:two" },
          { key: "agent:other:three" },
          { key: "global" },
        ],
      } as SessionsListResult),
    ).toEqual(["main", "other"]);
  });
});
