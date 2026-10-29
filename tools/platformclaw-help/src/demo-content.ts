// Synthetic examples only. No actual customer names, tickets or credentials.
export const projects = [
  {
    id: "ulysses",
    name: "Ulysses",
    issue: "ULY-142",
    document: "Ulysses 설계",
  },
  {
    id: "thetis",
    name: "Thetis",
    issue: "THET-58",
    document: "Thetis 인터페이스",
  },
  {
    id: "vanguard",
    name: "Vanguard",
    issue: "VAN-93",
    document: "Vanguard 배포 기준",
  },
] as const;

// Only Space questions and final answers form common context; private tool activity is not shared.
export const spaceExample = {
  project: "Ulysses",
  members: ["멤버 A", "멤버 B", "멤버 C"],
  contributions: [
    {
      member: "멤버 A",
      prompt: "Jira ULY-142 변경 범위는?",
      answer: "변경 범위 정리",
      reference: "Jira",
    },
    {
      member: "멤버 B",
      prompt: "Confluence 설계 영향은?",
      answer: "설계 영향 정리",
      reference: "설계",
    },
  ],
  followup: "두 검토를 이어서 Ulysses 릴리스 점검해줘",
  result: "Ulysses 릴리스 점검",
} as const;

export const agentSkills = [
  {
    name: "jira-issue-triage",
    tool: "Jira",
    detail: "Thetis 이슈 검토",
    steps: ["이슈 조회", "변경 분류"],
  },
  {
    name: "confluence-context",
    tool: "Confluence",
    detail: "Thetis 설계 확인",
    steps: ["설계 대조", "검토 정리"],
  },
] as const;
export const sharedSkill = {
  name: "jira-confluence-review",
  summary: "Jira · Confluence 검토 흐름",
  namespace: "vanguard",
};
export const suggestedSkill = {
  title: "Ulysses 릴리스 점검",
  name: "ulysses-release-review",
  question: "이 점검을 스킬로 만들까요?",
};
export const chatExample = {
  prompt: "Ulysses 릴리스 점검",
  title: "Ulysses 릴리스 점검",
  rows: ["Jira · ULY-142", "Confluence · Ulysses 설계", "릴리스 기준 정리"],
};
// Commands are typed in the motion; no Enter, remote execution or invented output.
export const terminalCommands = ["git status --short", "git log -5 --oneline"] as const;
export const memoryDocuments = [
  "Ulysses 릴리스 점검",
  "Jira · ULY-142",
  "Confluence · 설계",
  "릴리스 기준",
  "변경 이력",
] as const;
