import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PlatformClawSkillHubClient } from "./client.js";

/** The control plane owns room bindings and installed Hub provenance; core only narrows candidates. */
export function registerSkillHubRunPolicy(
  api: Pick<OpenClawPluginApi, "on">,
  client: PlatformClawSkillHubClient,
): void {
  api.on("before_skill_context", async (event, context) => {
    if (!context.agentId) {
      throw new Error("Company skill permissions require a prepared agent identity.");
    }
    let response: Awaited<ReturnType<PlatformClawSkillHubClient["roomSkills"]>>;
    try {
      response = await client.roomSkills({
        agentId: context.agentId,
        candidates: event.candidates,
      });
    } catch {
      throw new Error("Company skill permissions could not be verified. Try again shortly.");
    }
    const { status, body } = response;
    const candidates = new Set(event.candidates.map((candidate) => candidate.filePath));
    const excludedPaths = body.excludedPaths;
    if (status !== 200 || !Array.isArray(excludedPaths)) {
      throw new Error("Company skill permissions could not be verified. Try again shortly.");
    }
    const paths: string[] = [];
    for (const value of excludedPaths) {
      if (typeof value !== "string" || !candidates.has(value)) {
        throw new Error("Company skill permission response is invalid.");
      }
      paths.push(value);
    }
    const directories = body.excludedSourceDirectories;
    if (directories !== undefined && !Array.isArray(directories)) {
      throw new Error("Company skill source permission response is invalid.");
    }
    const sourceDirectories: string[] = [];
    for (const value of directories ?? []) {
      if (typeof value !== "string") {
        throw new Error("Company skill source permission response is invalid.");
      }
      sourceDirectories.push(value);
    }
    return {
      excludedPaths: paths,
      ...(directories !== undefined ? { excludedSourceDirectories: sourceDirectories } : {}),
    };
  });
}
