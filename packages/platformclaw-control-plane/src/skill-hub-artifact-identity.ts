import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SkillHubSkillDetail } from "./skill-hub-adapter.js";

export type SkillHubIdentityReservation = {
  namespace: string;
  slug: string;
  publicationId: string;
  revalidateAuthority(): Promise<void>;
};

export function readSkillHubArtifactMetadata(
  value: unknown,
  params: { namespace: string; slug: string; expectedSkillId?: number },
) {
  if (!isRecord(value)) {
    return null;
  }
  const data = value;
  if (
    !Number.isSafeInteger(data.id) ||
    Number(data.id) < 1 ||
    (params.expectedSkillId !== undefined && data.id !== params.expectedSkillId) ||
    data.namespace !== params.namespace ||
    data.slug !== params.slug ||
    typeof data.displayName !== "string" ||
    typeof data.summary !== "string" ||
    (data.visibility !== "PUBLIC" &&
      data.visibility !== "NAMESPACE_ONLY" &&
      data.visibility !== "PRIVATE") ||
    typeof data.status !== "string" ||
    !data.status
  ) {
    return null;
  }
  return {
    id: Number(data.id),
    namespace: params.namespace,
    slug: params.slug,
    displayName: data.displayName,
    summary: data.summary,
    visibility: data.visibility,
    status: data.status,
  } satisfies SkillHubSkillDetail;
}

export function readSkillHubArtifactDeletion(value: unknown, skillId: number) {
  if (!isRecord(value) || value.skillId !== skillId) {
    return null;
  }
  if (value.state === "pending") {
    return { skillId, state: "pending" as const };
  }
  if (
    value.state === "completed" &&
    typeof value.completedAt === "string" &&
    Number.isFinite(Date.parse(value.completedAt))
  ) {
    return { skillId, state: "completed" as const, completedAt: value.completedAt };
  }
  return null;
}
