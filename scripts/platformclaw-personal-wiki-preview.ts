import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compileMemoryWikiVault,
  configureMemoryWikiCompiledCacheStore,
  configureMemoryWikiSourceSyncStateStore,
  createMemoryWikiCompiledCacheStore,
  createMemoryWikiSourceSyncStateStore,
  getMemoryWikiDocument,
  getMemoryWikiPage,
  listMemoryWikiGraph,
  listMemoryWikiOverview,
  resolveMemoryWikiConfig,
  resolveMemoryWikiPromotionReferences,
  saveMemoryWikiDocument,
} from "../extensions/memory-wiki/document-api.js";
import { createPluginBlobStoreForTests } from "../src/plugin-state/plugin-blob-store.js";
import { createPluginStateKeyedStore } from "../src/plugin-state/plugin-state-store.js";

export const PERSONAL_WIKI_PREVIEW_METHODS = [
  "wiki.overview",
  "wiki.graph",
  "wiki.document.get",
  "wiki.document.save",
  "wiki.get",
  "wiki.references.resolve",
] as const;

type Kind = "source" | "concept" | "synthesis";
const pages: Array<{
  path: string;
  title: string;
  kind: Kind;
  id?: string;
  claims: string[];
  links: string[];
}> = [
  {
    path: "sources/가상-연결-실험.md",
    title: "가상 연결 실험 노트",
    kind: "source",
    claims: [
      "합성 예시: 가상 장치 연결이 끊기면 먼저 상태와 로그를 기록한다.",
      "실제 장비에 적용하는 운영 절차가 아니다.",
    ],
    links: ["concepts/연결-진단.md"],
  },
  {
    path: "sources/가상-검토-회의.md",
    title: "가상 검토 회의 노트",
    kind: "source",
    claims: ["합성 회의 예시: 적용 조건과 확인 근거를 함께 적기로 했다."],
    links: ["concepts/근거-기반-검토.md", "syntheses/가상-배포-확인.md"],
  },
  {
    path: "concepts/연결-진단.md",
    title: "연결 진단의 순서",
    kind: "concept",
    claims: ["합성 예시: 관찰 → 조건 구분 → 작은 재현 → 결과 기록 순서로 진단한다."],
    links: ["concepts/근거-기반-검토.md", "syntheses/가상-재연결-절차.md"],
  },
  {
    path: "concepts/근거-기반-검토.md",
    title: "근거를 남기는 검토",
    kind: "concept",
    claims: ["합성 예시: 주장, 적용 조건, 근거를 분리하면 다른 상황의 지식을 섞지 않는다."],
    links: ["syntheses/가상-배포-확인.md"],
  },
  {
    path: "syntheses/가상-재연결-절차.md",
    title: "가상 재연결 절차 정리",
    kind: "synthesis",
    claims: ["합성 정리: 연결 상태를 확인하고 재현 조건을 적은 뒤, 변경 전후 결과를 비교한다."],
    links: ["sources/가상-연결-실험.md", "concepts/연결-진단.md"],
  },
  {
    path: "syntheses/가상-배포-확인.md",
    title: "가상 배포 전 확인 정리",
    kind: "synthesis",
    claims: ["합성 정리: 변경 목적, 검증 결과, 되돌릴 방법을 확인 목록에 남긴다."],
    links: ["sources/가상-검토-회의.md", "concepts/근거-기반-검토.md"],
  },
  {
    path: "concepts/고립된-아이디어.md",
    title: "아직 연결하지 않은 아이디어",
    kind: "concept",
    claims: [
      "합성 예시: 아침에 떠오른 작은 아이디어를 따로 보관한다. 연결이 없는 노드도 확인할 수 있다.",
    ],
    links: [],
  },
  {
    path: "concepts/가상-승격-대상.md",
    id: "demo.native.reference-target",
    title: "가상 승격 대상 · 확인 절차",
    kind: "concept",
    claims: ["합성 예시: 변경 전후 상태와 적용 조건을 확인한다."],
    links: [],
  },
  {
    path: "syntheses/가상-승격-본문.md",
    id: "demo.native.reference-source",
    title: "가상 승격 본문 · 연결 검증",
    kind: "synthesis",
    claims: ["합성 예시: 확인한 절차를 참조하고 결과를 기록한다."],
    links: ["concepts/가상-승격-대상.md"],
  },
];
const byPath = new Map(pages.map((page) => [page.path, page]));
function content(page: (typeof pages)[number]): string {
  const backlinks = pages.filter((candidate) => candidate.links.includes(page.path));
  const link = (target: string) => `[[${target}|${byPath.get(target)!.title}]]`;
  return `# ${page.title}\n\n> DEMO · 가상 개인 Wiki · 편집 가능한 예시\n\n## 핵심 내용\n${page.claims.map((claim) => "- " + claim).join("\n")}\n\n## 관련 문서\n${page.links.length ? page.links.map((target) => "- " + link(target)).join("\n") : "- 아직 연결 없음"}\n\n## Backlinks\n${backlinks.length ? backlinks.map((candidate) => "- " + link(candidate.path)).join("\n") : "- 역링크 없음"}\n`;
}
export async function createPersonalWikiPreview(options: { directory: string; agentId: string }) {
  const root = path.resolve(options.directory, "personal-wiki-fixture-a");
  for (const page of pages) {
    const filename = path.join(root, page.path);
    await mkdir(path.dirname(filename), { recursive: true });
    try {
      await writeFile(
        filename,
        `---\ntitle: ${page.title}\n${page.id ? `id: ${page.id}\n` : ""}kind: ${page.kind}\npageType: ${page.kind}\nclaims: ${JSON.stringify(page.claims.map((text) => ({ text })))}\ndemo: true\n---\n\n${content(page)}`,
        { flag: "wx" },
      );
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  // The fixture is a named demo artifact. Native cache/state is isolated from operational agent state.
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(options.directory, "personal-wiki-state"),
  };
  configureMemoryWikiCompiledCacheStore(
    createMemoryWikiCompiledCacheStore((storeOptions) =>
      createPluginBlobStoreForTests("memory-wiki", storeOptions, env),
    ),
  );
  configureMemoryWikiSourceSyncStateStore(
    createMemoryWikiSourceSyncStateStore((storeOptions) =>
      createPluginStateKeyedStore("memory-wiki", { ...storeOptions, env }),
    ),
  );
  const config = {
    ...resolveMemoryWikiConfig({
      vault: { scope: "agent", path: root },
      bridge: { enabled: false },
      search: { backend: "local", corpus: "wiki" },
      render: { createDashboards: false },
    }),
    agentId: options.agentId,
  };
  await compileMemoryWikiVault(config);
  const emptyConfig = {
    ...config,
    vault: { ...config.vault, path: path.join(options.directory, "personal-wiki-empty") },
  };
  await mkdir(emptyConfig.vault.path, { recursive: true });
  return async (request: { actorKey: string; method: string; params: Record<string, unknown> }) => {
    if (!(PERSONAL_WIKI_PREVIEW_METHODS as readonly string[]).includes(request.method)) {
      return { handled: false as const };
    }
    const visible =
      request.actorKey === "A" &&
      (request.params.agentId === undefined || request.params.agentId === options.agentId);
    if (request.method === "wiki.overview") {
      return {
        handled: true as const,
        result: await listMemoryWikiOverview(visible ? config : emptyConfig),
      };
    }
    if (request.method === "wiki.graph") {
      return {
        handled: true as const,
        result: await listMemoryWikiGraph(visible ? config : emptyConfig),
      };
    }
    if (!visible) {
      throw new Error("DEMO personal Wiki document is unavailable for this actor");
    }
    if (request.method === "wiki.get" || request.method === "wiki.references.resolve") {
      if (typeof request.params.lookup !== "string") {
        throw new Error("A complete native Wiki source lookup is required.");
      }
      if (request.method === "wiki.references.resolve") {
        if (
          request.params.proposedText !== undefined &&
          typeof request.params.proposedText !== "string"
        ) {
          throw new Error("Submitted Wiki text must be a string.");
        }
        return {
          handled: true as const,
          result: await resolveMemoryWikiPromotionReferences({
            config,
            lookup: request.params.lookup,
            ...(typeof request.params.proposedText === "string"
              ? { proposedText: request.params.proposedText }
              : {}),
          }),
        };
      }
      return {
        handled: true as const,
        result: await getMemoryWikiPage({
          config,
          lookup: request.params.lookup,
          fromLine: 1,
          lineCount: 10_000,
          searchBackend: "local",
          searchCorpus: "wiki",
        }),
      };
    }
    if (request.method === "wiki.document.get") {
      if (typeof request.params.lookup !== "string") {
        throw new Error("A complete Wiki document lookup is required.");
      }
      return {
        handled: true as const,
        result: await getMemoryWikiDocument({ config, lookup: request.params.lookup }),
      };
    }
    if (
      typeof request.params.path !== "string" ||
      typeof request.params.content !== "string" ||
      typeof request.params.expectedRevision !== "string" ||
      (request.params.editMode !== "body" && request.params.editMode !== "notes")
    ) {
      throw new Error("Reload the complete Wiki document before editing.");
    }
    return {
      handled: true as const,
      result: await saveMemoryWikiDocument({
        config,
        path: request.params.path,
        content: request.params.content,
        expectedRevision: request.params.expectedRevision,
        editMode: request.params.editMode,
      }),
    };
  };
}
