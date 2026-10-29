export const topics = [
  {
    id: "chat",
    composition: "Help-Chat",
    title: "챗 · VM · 터미널",
    word: "Chat",
    description: "대화로 작업하고, 플코 안의 VM 터미널에서 이어갑니다.",
    seconds: 15,
    scenes: [
      { at: 0, label: "Identity" },
      { at: 1.8, label: "Compose" },
      { at: 3.7, label: "Conversation" },
      { at: 5.9, label: "Connect VM" },
      { at: 6.6, label: "Switch workspace" },
      { at: 7, label: "VM ready" },
      { at: 7.2, label: "Integrated terminal" },
      { at: 7.9, label: "Type command" },
      { at: 9.8, label: "New terminal tab" },
      { at: 13, label: "Brand" },
    ],
  },
  {
    id: "spaces",
    composition: "Help-Spaces",
    title: "Spaces",
    word: "Spaces",
    description:
      "같은 과제의 멤버를 초대하고 프롬프트와 Q&A를 공유합니다. 각자의 에이전트가 공용 맥락을 참고해 작업을 이어갑니다.",
    seconds: 18,
    scenes: [
      { at: 0, label: "Identity" },
      { at: 1.5, label: "Invite teammates" },
      { at: 4, label: "Share prompts and Q&A" },
      { at: 8.5, label: "Common Space context" },
      { at: 10.4, label: "Continue with shared context" },
      { at: 16, label: "Brand" },
    ],
  },
  {
    id: "cron",
    composition: "Help-Cron",
    title: "자동화",
    word: "Automations",
    description: "정해 둔 프롬프트를 예약하고 반복 작업을 맡깁니다.",
    seconds: 18,
    scenes: [
      { at: 0, label: "Identity" },
      { at: 1.5, label: "Task prompt" },
      { at: 3.1, label: "Schedule" },
      { at: 5, label: "Agent run" },
      { at: 8.5, label: "Repeat" },
      { at: 12, label: "Run history" },
      { at: 16, label: "Brand" },
    ],
  },
  {
    id: "skills",
    composition: "Help-Skills",
    title: "Skills",
    word: "Skills",
    description: "에이전트가 스킬 지침을 읽고 작업에 활용합니다.",
    seconds: 14,
    scenes: [
      { at: 0, label: "Identity" },
      { at: 1.5, label: "Agent skills" },
      { at: 5, label: "Use tools" },
      { at: 9, label: "Task context" },
      { at: 12, label: "Brand" },
    ],
  },
  {
    id: "skill-workshop",
    composition: "Help-Workshop",
    title: "Skill Workshop",
    word: "Workshop",
    description: "작업 경험에서 에이전트가 스킬을 제안하고 사용자가 검토합니다.",
    seconds: 14,
    scenes: [
      { at: 0, label: "Identity" },
      { at: 1.5, label: "Agent observes" },
      { at: 5, label: "Agent proposes" },
      { at: 9, label: "Human reviews" },
      { at: 12, label: "Brand" },
    ],
  },
  {
    id: "skill-hub",
    composition: "Help-Hub",
    title: "Skill Hub",
    word: "Skill Hub",
    description: "직접 만든 스킬을 팀에 공유하고 서로 가져다 씁니다.",
    seconds: 14,
    scenes: [
      { at: 0, label: "Identity" },
      { at: 1.5, label: "User authors" },
      { at: 5, label: "Publish skill" },
      { at: 9, label: "Share with users" },
      { at: 12, label: "Brand" },
    ],
  },
  {
    id: "memory",
    composition: "Help-Memory",
    title: "메모리 · Wiki · 그래프",
    word: "Memory",
    description: "Wiki의 연결을 따라 필요한 지식을 다시 찾습니다.",
    seconds: 20,
    scenes: [
      { at: 0, label: "Identity" },
      { at: 1.5, label: "Documents" },
      { at: 5.5, label: "Connect" },
      { at: 11, label: "Explore" },
      { at: 18, label: "Brand" },
    ],
  },
  {
    id: "credentials",
    composition: "Help-Credentials",
    title: "설정 · 크리덴셜",
    word: "Credentials",
    description: "필요한 키를 내 인증정보에 등록하고 대화로 돌아옵니다.",
    seconds: 14,
    scenes: [
      { at: 0, label: "Identity" },
      { at: 1.5, label: "Credential request" },
      { at: 3.6, label: "Private form" },
      { at: 7.3, label: "Store masked value" },
      { at: 9.1, label: "Return to chat" },
      { at: 12, label: "Brand" },
    ],
  },
] as const;
export type TopicId = (typeof topics)[number]["id"];
export type Topic = (typeof topics)[number];
export function sceneAt(topic: Topic, frame: number, fps = 30) {
  let index = 0;
  for (const [sceneIndex, scene] of topic.scenes.entries()) {
    if (frame >= scene.at * fps) {
      index = sceneIndex;
    }
  }
  return { index, scene: topic.scenes[index] };
}
