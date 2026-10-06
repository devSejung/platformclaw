import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe } from "vitest";
import { SPACE_RPC_METHODS } from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createPlatformClawMemoryContext,
  installPlatformClawMemoryDocument,
  platformClawMemoryAgentId,
  platformClawMemoryMethods,
  platformClawMemoryResponses,
} from "../test-helpers/platformclaw-memory-fixture.ts";

// Real shipped UI in Chromium; synthetic identities and Gateway replies only.
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
export const suite =
  available || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "spaces");
export const rpc = "platformclaw.spaces.";
export const space = {
  id: "work-optics",
  name: "Optics Reliability Project",
  role: "owner",
  revision: 1,
  agentId: "space-synthetic",
};
export const issue = {
  id: "issue-timing",
  spaceId: space.id,
  parentId: null,
  title: "Cold-start timing issue",
  body: "Board revision C: compare cold-start traces before changing the timing configuration.",
  revision: 1,
  createdBy: "alice",
  updatedAt: 1790856000000,
};
export const child = {
  ...issue,
  id: "issue-followup",
  parentId: issue.id,
  title: "Revision C follow-up",
  body: "Reproduce with the same board revision.",
};
export const alice = {
  userId: "alice",
  accountId: "alice.synthetic",
  displayName: "Alice Example",
  role: "owner",
};
export const bob = {
  userId: "bob",
  accountId: "bob.synthetic",
  displayName: "Bob Example",
  role: "editor",
};
export const messages = [
  {
    id: "message-a",
    role: "user",
    text: "Does the startup timeout depend on board revision?",
    authorName: alice.displayName,
    timestamp: issue.updatedAt,
  },
  {
    id: "message-b",
    role: "assistant",
    text: "The shared notes describe revision C. Compare the cold-start conditions before assuming the same cause.",
    timestamp: issue.updatedAt + 1000,
  },
] as const;
export const conversation = {
  id: "conversation-alice",
  spaceId: space.id,
  pageId: issue.id,
  title: "Compare revision C traces",
  ownerId: alice.userId,
  ownerName: alice.displayName,
  agentId: platformClawMemoryAgentId,
  sessionKey: `agent:${platformClawMemoryAgentId}:space-session:00000000-0000-4000-8000-000000000001`,
  createdAt: issue.updatedAt,
  canWrite: true,
};
const nativeMessages = [
  {
    id: "personal-user",
    role: "user",
    content: [{ type: "text", text: "Compare the revision C evidence." }],
    timestamp: issue.updatedAt,
  },
  {
    id: "personal-assistant",
    role: "assistant",
    content: [
      { type: "text", text: "The personal agent found the shared timing evidence." },
      { type: "toolCall", id: "call-shared-read", name: "read", arguments: { path: "traces.txt" } },
    ],
    timestamp: issue.updatedAt + 1000,
  },
  {
    role: "toolResult",
    toolCallId: "call-shared-read",
    toolName: "read",
    content: [{ type: "text", text: "Revision C cold-start traces" }],
    timestamp: issue.updatedAt + 2000,
  },
];
export const nativeSessionCases = [
  {
    locale: "en-US",
    prefix: "owner",
    newConversation: "New conversation",
    titleLabel: "Title",
    sharingPrivate: "Only you can open this conversation",
    sharingPublic: "Questions and final answers",
    createConversation: "Create conversation",
    personalAgent: "Your personal agent",
    sendMessage: "Send message",
    stopGenerating: "Stop generating",
    allowOnce: "Allow once",
    approvalTitle: "Exec approval needed",
    question: "Inspect the cold-start trace on my personal agent.",
    progress: "Inspecting the trace privately before summarizing.",
    resume: "Continue with only the final summary.",
    finalAnswer: "The final summary is available for Space agent recall.",
    historyAnswer: "The personal agent found the shared timing evidence.",
    tracePath: "private-cold-start-trace.txt",
  },
  {
    locale: "ko-KR",
    prefix: "owner-korean",
    newConversation: "새 대화",
    titleLabel: "제목",
    sharingPrivate: "이 대화는 본인만 열어볼 수 있습니다",
    sharingPublic: "질문과 최종 답변",
    createConversation: "대화 만들기",
    personalAgent: "내 개인 에이전트",
    sendMessage: "메시지 보내기",
    stopGenerating: "생성 중지",
    allowOnce: "한 번 허용",
    approvalTitle: "명령 실행 승인 필요",
    question: "내 개인 에이전트로 C형 보드의 저온 기동 로그를 확인해 줘.",
    progress:
      "개인 작업 공간의 로그를 확인하고 있습니다. 도구 활동은 다른 구성원에게 공개되지 않습니다.",
    resume: "최종 요약만 이어서 알려 줘.",
    finalAnswer:
      "C형 보드는 저온 기동에서 응답 지연이 확인됐습니다. 같은 조건으로 재측정한 뒤 타이밍 설정 변경 여부를 결정하세요. 이 질문과 최종 답변은 Space 에이전트가 참고할 수 있습니다.",
    historyAnswer: "공유 노트에서 C형 보드의 타이밍 근거를 찾았습니다.",
    tracePath: "개인-저온-기동-로그.txt",
  },
] as const;

export function spaceFixture(locale: string) {
  if (locale !== "ko-KR") {
    return { space, issue, child, alice, bob, conversation, messages, nativeMessages };
  }
  const ownerName = "김민서 (예시)";
  return {
    space: { ...space, name: "광학 장비 신뢰성 개선" },
    issue: {
      ...issue,
      title: "저온 기동 타이밍 문제",
      body: "C형 보드의 저온 기동 로그를 비교하고 타이밍 설정 변경 여부를 검토합니다.",
    },
    child: {
      ...child,
      title: "C형 보드 재현 시험",
      body: "동일한 보드와 온도 조건에서 다시 측정합니다.",
    },
    alice: { ...alice, displayName: ownerName },
    bob: { ...bob, displayName: "이도윤 (예시)" },
    conversation: { ...conversation, title: "C형 보드 로그 비교", ownerName },
    messages: [
      {
        ...messages[0],
        authorName: ownerName,
        text: "기동 시간 초과가 보드 종류에 따라 달라지나요?",
      },
      {
        ...messages[1],
        text: "공유 노트는 C형 보드의 결과입니다. 같은 원인으로 판단하기 전에 저온 기동 조건을 비교하세요.",
      },
    ] as const,
    nativeMessages: [
      {
        ...nativeMessages[0],
        content: [{ type: "text", text: "C형 보드의 측정 근거를 비교해 줘." }],
      },
      {
        ...nativeMessages[1],
        content: [
          { type: "text", text: "공유 노트에서 C형 보드의 타이밍 근거를 찾았습니다." },
          {
            type: "toolCall",
            id: "call-shared-read",
            name: "read",
            arguments: { path: "공유-측정-로그.txt" },
          },
        ],
      },
      { ...nativeMessages[2], content: [{ type: "text", text: "C형 보드 저온 기동 측정 로그" }] },
    ],
  };
}
let browser: Browser;
export let server: ControlUiE2eServer;

export async function setup(
  name: string,
  width = 1440,
  role = "owner",
  locale = "en-US",
  conversations: Array<typeof conversation> = [],
  spaceState: { revision?: number; deleting?: true; leaving?: true } = {},
) {
  const fixture = spaceFixture(locale);
  const context = await createPlatformClawMemoryContext(browser, server.baseUrl, {
    locale,
    mode: "light",
    recordVideo: { dir: proofDir, size: { width, height: 1000 } },
    viewport: { width, height: 1000 },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installPlatformClawMemoryDocument(page, server.baseUrl);
  if (locale === "ko-KR") {
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({
        json: {
          authenticated: true,
          user: {
            accountId: fixture.alice.accountId,
            displayName: fixture.alice.displayName,
            department: "신뢰성 개발팀 (예시)",
            globalRole: "member",
          },
          agent: { agentId: platformClawMemoryAgentId, state: "active" },
        },
      }),
    );
  }
  const snapshot = {
    space: { ...fixture.space, role, ...spaceState },
    pages: [fixture.issue, fixture.child],
    members: [fixture.alice, fixture.bob],
    currentUserId: role === "owner" ? fixture.alice.userId : fixture.bob.userId,
    conversations,
  };
  const gateway = await installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: platformClawMemoryAgentId,
    sessionKey: fixture.conversation.sessionKey,
    historyMessages: fixture.nativeMessages,
    featureMethods: [
      ...platformClawMemoryMethods,
      ...SPACE_RPC_METHODS,
      "chat.abort",
      "chat.history",
      "chat.metadata",
      "chat.send",
      "chat.startup",
      "sessions.list",
      "sessions.patch",
      "sessions.subscribe",
      "sessions.messages.subscribe",
      "sessions.messages.unsubscribe",
      "exec.approval.resolve",
    ],
    methodResponses: {
      ...platformClawMemoryResponses,
      ...(locale === "ko-KR"
        ? {
            "agents.list": {
              agents: [{ id: platformClawMemoryAgentId, name: "내 개인 에이전트" }],
              defaultId: platformClawMemoryAgentId,
              mainKey: platformClawMemoryAgentId,
              scope: "agent",
            },
          }
        : {}),
      [`${rpc}list`]: [snapshot.space],
      [`${rpc}get`]: snapshot,
      [`${rpc}create`]: fixture.space,
      [`${rpc}page.create`]: fixture.issue,
      [`${rpc}chat.history`]: { messages: fixture.messages },
      [`${rpc}conversation.create`]: fixture.conversation,
      [`${rpc}conversation.history`]: {
        messages: fixture.nativeMessages,
        sessionKey: fixture.conversation.sessionKey,
        conversation: conversations[0] ?? fixture.conversation,
      },
      [`${rpc}people`]: [fixture.bob],
      [`${rpc}member.set`]: { updated: true },
      [`${rpc}member.remove`]: { updated: true },
      [`${rpc}search`]: {
        results: [
          {
            spaceId: fixture.space.id,
            pageId: fixture.issue.id,
            pageTitle: fixture.issue.title,
            snippet: fixture.messages[0].text,
            messageId: "message-a",
            link: `/spaces?space=${fixture.space.id}&page=${fixture.issue.id}&message=message-a`,
          },
        ],
      },
    },
  });
  return { context, page, gateway, snapshot, fixture, name };
}
export async function capture(page: Page, name: string) {
  await page.screenshot({
    path: path.join(proofDir, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}
export async function finish(context: BrowserContext, page: Page, name: string) {
  const video = page.video();
  try {
    await capture(page, `${name}-final`);
  } finally {
    await context.tracing.stop({ path: path.join(proofDir, `${name}-trace.zip`) });
    await context.close();
    await video?.saveAs(path.join(proofDir, `${name}.webm`));
  }
}
export function setupSpaceBrowserTests() {
  beforeAll(async () => {
    if (!available) {
      throw new Error("Playwright Chromium is required for Space browser verification.");
    }
    await mkdir(proofDir, { recursive: true });
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });
}
