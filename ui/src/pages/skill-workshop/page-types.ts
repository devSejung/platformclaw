import type { SkillWorkshopState } from "./proposals.ts";
import type { SkillWorkshopSelfLearning } from "./self-learning.ts";
import type { SkillWorkshopPageContext } from "./source-scope.ts";
import type { SkillWorkshopExecutionTarget } from "./view-types.ts";

export type SkillWorkshopProposal = SkillWorkshopState["skillWorkshopProposals"][number];

export type SkillWorkshopRevisionRequest = (
  instructions: string,
  proposal: SkillWorkshopProposal,
  proposalAgentId: string,
) => Promise<void>;

export type SkillWorkshopRenderContext = {
  context: SkillWorkshopPageContext;
  workshopAgentName: string;
  currentExecutionTarget?: SkillWorkshopExecutionTarget | null;
  onRevisionRequest?: SkillWorkshopRevisionRequest;
  selfLearning: SkillWorkshopSelfLearning | null;
  onSelfLearningToggle: (enabled: boolean) => void;
  onHistoryScan: () => void;
  onRetry: () => void;
};
