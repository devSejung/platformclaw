// Local review fixture only: real SQLite knowledge jobs, synthetic identities,
// deterministic analysis, and the existing mocked Control UI Gateway shell.
import { mkdir, access } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createServer, type Plugin } from "vite";
import { BrowserGatewayProxyError } from "../packages/platformclaw-control-plane/src/browser-gateway-contracts.js";
import { requestBrowserOrganizationKnowledge } from "../packages/platformclaw-control-plane/src/browser-gateway-knowledge.js";
import { requestBrowserOrganizationMemoryLifecycle } from "../packages/platformclaw-control-plane/src/browser-gateway-memory-lifecycle.js";
import { requestBrowserOrganizationMemoryGet } from "../packages/platformclaw-control-plane/src/browser-gateway-memory.js";
import { requestBrowserOrganizationMemoryGraph } from "../packages/platformclaw-control-plane/src/browser-gateway-organization-graph.js";
import type { PersonalOrganizationMemorySource } from "../packages/platformclaw-control-plane/src/contracts.js";
import { createOrganizationKnowledgeAnalyzer } from "../packages/platformclaw-control-plane/src/organization-knowledge-analysis.js";
import { OrganizationKnowledgeService } from "../packages/platformclaw-control-plane/src/organization-knowledge-service.js";
import { SqliteControlPlaneStore } from "../packages/platformclaw-control-plane/src/sqlite-store.js";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../ui/src/platformclaw/web-contract.js";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  type ControlUiMockGatewayScenario,
} from "../ui/src/test-helpers/control-ui-e2e.js";
import {
  createPersonalWikiPreview,
  PERSONAL_WIKI_PREVIEW_METHODS,
} from "./platformclaw-personal-wiki-preview.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] ?? "5198");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Invalid preview port");
}
const resumeArgument = process.argv[3];
const resume = resumeArgument !== undefined;
const priorAnalysisCalls = Number(process.argv[4] ?? "0");
if (
  !Number.isSafeInteger(priorAnalysisCalls) ||
  priorAnalysisCalls < 0 ||
  priorAnalysisCalls > 1_000_000
) {
  throw new Error("Invalid synthetic preview analysis counter");
}
const demoRoot = path.join(repoRoot, ".artifacts", "knowledge-preview");
const databasePath = resume
  ? path.resolve(resumeArgument)
  : path.join(demoRoot, String(Date.now()), "demo.sqlite");
if (
  resume &&
  (!databasePath.startsWith(`${demoRoot}${path.sep}`) ||
    path.basename(databasePath) !== "demo.sqlite")
) {
  throw new Error("Resume supports only the isolated synthetic demo database");
}
if (resume) {
  await access(databasePath);
}
const directory = path.dirname(databasePath);
await mkdir(directory, { recursive: true });
let nextId = 0;
const legacyPersonalLookups = new Set([
  ...Array.from({ length: 7 }, (_, index) => `demo/claim-${index}.md`),
  "demo/group-claim.md",
  "demo/pending-comparison.md",
]);
const store = new SqliteControlPlaneStore({
  databasePath,
  initialAdminAccountIds: ["demo-seeder"],
  buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  ...(resume
    ? {}
    : {
        idFactory: {
          nextUserId: () => `demo-user-${++nextId}`,
          nextBindingId: () => `demo-binding-${++nextId}`,
          nextSessionId: () => `demo-session-${++nextId}`,
          nextManagedScopeId: () => `demo-scope-${++nextId}`,
          nextAuditEventId: () => `demo-audit-${++nextId}`,
        },
      }),
  resolvePersonalOrganizationMemorySource: async ({ agentId, lookup, proposedText }) => {
    // Existing synthetic requests keep their fixture revision; new Wiki pages
    // resolve through the native document owner and trusted reference spans.
    if (legacyPersonalLookups.has(lookup)) {
      if (agentId !== actors.A.binding.agentId && agentId !== seeder.binding.agentId) {
        return null;
      }
      return { claimId: lookup, revision: 1 };
    }
    if (agentId !== actors.A.binding.agentId) {
      return null;
    }
    const result = await personalWikiPreview({
      actorKey: "A",
      method: "wiki.references.resolve",
      params: { agentId, lookup, ...(proposedText === undefined ? {} : { proposedText }) },
    });
    return result.handled ? (result.result as PersonalOrganizationMemorySource | null) : null;
  },
});
async function user(accountId: string, displayName: string) {
  if (resume) {
    const existingUser = await store.getUserByAccountId(accountId);
    const binding = existingUser && (await store.getPersonalAgentBinding(existingUser.id));
    if (!existingUser || !binding) {
      throw new Error("Existing synthetic actor is missing");
    }
    return { user: existingUser, binding, label: displayName };
  }
  const result = await store.upsertPrincipal(
    { provider: "ldap", subject: accountId, accountId, employeeId: accountId, displayName },
    Date.now(),
  );
  const reserved = await store.reservePersonalAgent(result.user.id, Date.now());
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: Date.now(),
  });
  return { user: result.user, binding, label: displayName };
}
const seeder = await user("demo-seeder", "DEMO 데이터 생성자");
const actors = {
  A: await user("demo-leader-a", "DEMO 파트 리더 A"),
  B: await user("demo-leader-b", "DEMO 파트 리더 B"),
  G: await user("demo-group-leader", "DEMO 그룹 리더"),
  D: await user("demo-unrelated", "DEMO 무소속 사용자 (권한 없음)"),
};
const existingScopes = resume ? await store.listManagedScopes() : [];
const personalWikiPreview = await createPersonalWikiPreview({
  directory,
  agentId: actors.A.binding.agentId,
});
if (resume) {
  const lifecycle = await store.getOrganizationMemoryLifecycle(actors.A.binding.agentId);
  for (const request of lifecycle.submitted) {
    if (
      request.sourceKind === "personal" &&
      request.sourceRevision === 1 &&
      typeof request.sourceClaimId === "string"
    ) {
      legacyPersonalLookups.add(request.sourceClaimId);
    }
  }
}
const team = resume
  ? existingScopes.find((scope) => scope.kind === "team" && scope.name === "DEMO 팀")!
  : await store.createManagedScope({
      actorUserId: seeder.user.id,
      kind: "team",
      name: "DEMO 팀",
      createdAt: Date.now(),
    });
const group = resume
  ? existingScopes.find((scope) => scope.kind === "group" && scope.name === "DEMO 그룹")!
  : await store.createManagedScope({
      actorUserId: seeder.user.id,
      kind: "group",
      name: "DEMO 그룹",
      parentScopeId: team.id,
      createdAt: Date.now(),
    });
const part = resume
  ? existingScopes.find((scope) => scope.kind === "part" && scope.name === "DEMO 파트 A")!
  : await store.createManagedScope({
      actorUserId: seeder.user.id,
      kind: "part",
      name: "DEMO 파트 A",
      parentScopeId: group.id,
      createdAt: Date.now(),
    });
if (
  !team ||
  !group ||
  !part ||
  group.parentScopeId !== team.id ||
  part.parentScopeId !== group.id
) {
  throw new Error("Existing synthetic Group/Part topology does not match; no seeding performed");
}
if (!resume) {
  for (const actor of [actors.A, actors.B]) {
    await store.setManagedScopeMembership({
      actorUserId: seeder.user.id,
      scopeId: part.id,
      userId: actor.user.id,
      role: "leader",
      reason: "Synthetic review fixture",
      changedAt: Date.now(),
    });
  }
  await store.setManagedScopeMembership({
    actorUserId: seeder.user.id,
    scopeId: group.id,
    userId: actors.G.user.id,
    role: "leader",
    reason: "Synthetic review fixture",
    changedAt: Date.now(),
  });
}

const claimSeeds = [
  {
    title: "연결 재시도 해결 절차",
    text: "Board-X v1.2 연결 timeout은 adapter restart 후 다시 연결하여 해결한다.",
    evidence: ["DEMO 검증 노트 A: Board-X v1.2 재연결 확인"],
    category: "duplicate",
  },
  {
    title: "어댑터 복구 가이드",
    text: "Board-X v1.2 연결 timeout 해결 방법은 adapter restart 이후 재연결이다.",
    evidence: ["DEMO 검증 노트 B: 같은 재연결 절차 확인"],
    category: "duplicate",
  },
  {
    title: "구형 보드 조건",
    text: "Board-X v1.2 연결 timeout에서 adapter restart가 필요하다. Board-X v2.0에는 적용하지 않는다.",
    evidence: ["DEMO 버전별 검증표: v1.2만 적용"],
    category: "condition-difference",
  },
  {
    title: "신형 보드 조건",
    text: "Board-X v2.0 연결 timeout에서 adapter restart 대신 firmware reload를 사용한다. v1.2는 별도 절차다.",
    evidence: ["DEMO 버전별 검증표: v2.0만 적용"],
    category: "condition-difference",
  },
  {
    title: "검증 없는 반대 주장",
    text: "Board-X 연결 timeout은 adapter restart를 절대 사용하지 말고 케이블을 교체하면 항상 해결된다.",
    evidence: [],
    category: "insufficient-evidence",
  },
  {
    title: "복구 후 확인 항목",
    text: "Board-X v1.2 연결 timeout 해결을 위해 adapter restart 후 재연결하고 status ready와 이벤트 로그를 확인한다.",
    evidence: ["DEMO 검증 노트 C: 재연결 후 ready 확인"],
    category: "enrichment",
  },
] as const;
const categories = new Map<string, string>();
if (!resume) {
  for (const [index, claim] of claimSeeds.entries()) {
    const result = await store.publishOrganizationMemoryDirect({
      agentId: seeder.binding.agentId,
      sourceKind: "personal",
      sourceClaimId: `demo/claim-${index}.md`,
      targetKind: "part",
      targetScopeId: part.id,
      proposedText: `# ${claim.title}\n\n${claim.text}`,
      evidence: [...claim.evidence],
      reason: "DEMO synthetic approved knowledge; not real operational guidance",
      publishedAt: Date.now(),
    });
    if (result.targetClaimId) {
      categories.set(result.targetClaimId, claim.category);
    }
  }
  await store.publishOrganizationMemoryDirect({
    agentId: seeder.binding.agentId,
    sourceKind: "personal",
    sourceClaimId: "demo/group-claim.md",
    targetKind: "group",
    targetScopeId: group.id,
    proposedText: "# 그룹 승인 절차\n\nDEMO 그룹의 Board-X 변경은 두 명의 검토 확인 후 진행한다.",
    evidence: ["DEMO 그룹 검증 노트"],
    reason: "Synthetic independent Group fixture",
    publishedAt: Date.now(),
  });
  await store.submitOrganizationMemoryPromotion({
    agentId: actors.A.binding.agentId,
    sourceKind: "personal",
    sourceClaimId: "demo/pending-comparison.md",
    targetKind: "part",
    targetScopeId: part.id,
    proposedText:
      "# DEMO 추가 복구 확인\n\nBoard-X v1.2 연결 timeout은 adapter restart 후 재연결하고 ready와 이벤트 로그를 확인한다.",
    evidence: ["DEMO 합성 검증 노트"],
    reason: "DEMO 기존 지식 비교 후 승인 검토",
    submittedAt: Date.now(),
  });
} else {
  const lifecycle = await store.getOrganizationMemoryLifecycle(actors.A.binding.agentId);
  for (const claim of lifecycle.claims) {
    const seed = claimSeeds.find(
      (candidate) => claim.text === `# ${candidate.title}\n\n${candidate.text}`,
    );
    if (seed) {
      categories.set(claim.id, seed.category);
    }
  }
}
// Resume carries only the demo process diagnostic; no persisted report changes.
let analysisCalls = priorAnalysisCalls;
// Pinned synthetic cases only. A version-conditioned item never becomes an
// enrichment proposal merely because its peer mentions a ready-state check.
const demoPairCases: Readonly<Record<string, "duplicate" | "enrichment" | "condition-difference">> =
  {
    "duplicate|duplicate": "duplicate",
    "duplicate|enrichment": "enrichment",
    "condition-difference|duplicate": "condition-difference",
    "condition-difference|enrichment": "condition-difference",
    "condition-difference|condition-difference": "condition-difference",
  };
const analyze = createOrganizationKnowledgeAnalyzer({
  extractKeywords: (text) => text.match(/[\p{L}\p{N}_.-]+/gu) ?? [],
  completePair: async (claims, signal) => {
    signal.throwIfAborted();
    analysisCalls++;
    const categoriesForPair = claims
      .map((claim) => categories.get(claim.id) ?? "unmapped")
      .toSorted()
      .join("|");
    const kind = claims.some((claim) => claim.evidence.length === 0)
      ? "insufficient-evidence"
      : (demoPairCases[categoriesForPair] ?? "insufficient-evidence");
    return {
      kind,
      claimIds: claims.map((claim) => claim.id),
      claimRevisions: claims.map(({ id, revision }) => ({ id, revision })),
      summary:
        kind === "duplicate"
          ? "DEMO 가상 분석: 제목은 다르지만 같은 버전의 같은 해결 절차입니다."
          : kind === "enrichment"
            ? "DEMO 가상 분석: 같은 복구 절차에 ready 상태·로그 확인 근거를 보완할 수 있습니다."
            : kind === "insufficient-evidence"
              ? "DEMO 가상 분석: 반대 주장에 검증 근거가 없어 실제 충돌로 단정할 수 없습니다."
              : "DEMO 가상 분석: 보드·버전 조건을 구분해야 하며, 조건이 다르면 같은 규칙으로 합치지 않습니다.",
      ...(kind === "enrichment"
        ? {
            proposedText:
              "DEMO 제안: Board-X v1.2 재연결 절차에 ready 상태 및 이벤트 로그 확인을 추가합니다.",
          }
        : {}),
    };
  },
});
const service = new OrganizationKnowledgeService(store, analyze);

function actorFrom(req: IncomingMessage) {
  const parsed = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const query = parsed.searchParams.get("demoActor");
  const cookie = /(?:^|;\s*)demoActor=([ABGD])(?:;|$)/u.exec(req.headers.cookie ?? "")?.[1];
  const selected = query ?? cookie ?? "A";
  return selected === "B" || selected === "G" || selected === "D" ? selected : "A";
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) {
    text += String(chunk);
    if (text.length > 32_000) {
      throw new Error("Preview request too large");
    }
  }
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("Invalid preview body");
  }
  return value;
}
function scenarioFor(actorKey: keyof typeof actors): ControlUiMockGatewayScenario {
  const actor = actors[actorKey];
  return {
    basePath: "/platformclaw/app",
    defaultAgentId: actor.binding.agentId,
    agentModel: null,
    featureMethods: [
      ...PERSONAL_WIKI_PREVIEW_METHODS,
      "agents.list",
      "platformclaw.memory.lifecycle",
      "platformclaw.memory.graph",
      "platformclaw.memory.get",
      "platformclaw.memory.knowledge.snapshot",
      "platformclaw.memory.knowledge.generate",
      "platformclaw.memory.knowledge.decide",
      "platformclaw.memory.knowledge.apply",
      "platformclaw.memory.knowledge.comparePromotion",
      "platformclaw.memory.promotion.submit",
      "platformclaw.memory.promotion.previewReferences",
      "platformclaw.memory.promotion.decide",
    ],
    methodResponses: {
      "agents.list": {
        agents: [{ id: actor.binding.agentId, name: actor.label }],
        defaultId: actor.binding.agentId,
        mainKey: actor.binding.agentId,
        scope: "agent",
      },
    },
  };
}
const bridgeScript = `
(() => {
  const MockSocket = window.WebSocket;
  class DemoSocket extends MockSocket {
    send(raw) {
      let frame;
      try { frame = JSON.parse(raw); } catch { return super.send(raw); }
      if (!frame.method?.startsWith('platformclaw.memory.') && !frame.method?.startsWith('wiki.')) return super.send(raw);
      fetch('/__knowledge_demo/request', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify(frame)})
        .then(response => response.json()).then(response => this.deliver({type:'res', id:frame.id, ...response}))
        .catch(() => this.deliver({type:'res',id:frame.id,ok:false,error:{code:'UNAVAILABLE',message:'DEMO server unavailable'}}));
    }
  }
  window.WebSocket = DemoSocket;
})();`;
const bannerScript = `
(() => {
  localStorage.setItem('openclaw.i18n.locale', 'ko');
  const selected = new URL(location.href).searchParams.get('demoActor') || 'A';
  document.cookie = 'demoActor=' + (['A','B','G','D'].includes(selected) ? selected : 'A') + '; Path=/; SameSite=Strict';
  document.addEventListener('DOMContentLoaded', () => {
    const banner = document.createElement('aside');
    banner.setAttribute('data-knowledge-demo','');
    banner.style.cssText='position:fixed;top:0;left:0;right:0;z-index:10000;background:#fff0b3;color:#28220b;padding:8px 16px;font:14px system-ui;display:flex;gap:12px;align-items:center;flex-wrap:wrap';
    const text = document.createElement('strong'); text.textContent='DEMO · 가상 지식·가상 분석 · 개인 Wiki 편집·컴파일 예시 · 외부 모델 호출 없음'; banner.append(text);
    const select = document.createElement('select'); select.setAttribute('aria-label','DEMO 사용자');
    for (const [value,label] of [['A','파트 리더 A'],['B','파트 리더 B (같은 리포트)'],['G','그룹 리더'],['D','무소속 (권한 없음)']]) {
      const option=document.createElement('option');option.value=value;option.textContent=label;option.selected=value===selected;select.append(option);
    }
    select.onchange=()=> { location.href='/platformclaw/app/settings/memory/organization?demoActor='+select.value; };
    banner.append(select);document.body.append(banner);document.body.style.paddingTop='64px';
  });
})();`;
const plugin: Plugin = {
  name: "platformclaw-knowledge-review-demo",
  enforce: "pre",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const pathname = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname;
      const actorKey = actorFrom(req);
      const actor = actors[actorKey];
      if (pathname === "/platformclaw/api/auth/session") {
        json(res, {
          authenticated: true,
          user: {
            accountId: actor.user.accountId,
            displayName: actor.label,
            department: "DEMO",
            globalRole: "member",
          },
          agent: { agentId: actor.binding.agentId, state: "active" },
        });
        return;
      }
      if (pathname.endsWith("/control-ui-config.json")) {
        json(res, createControlUiMockBootstrapConfig(scenarioFor(actorKey)));
        return;
      }
      if (pathname === "/__knowledge_demo/bootstrap.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Cache-Control", "no-store");
        res.end(createControlUiMockGatewayInitScript(scenarioFor(actorKey)) + bridgeScript);
        return;
      }
      if (pathname === "/__knowledge_demo/status") {
        json(res, {
          demo: true,
          externalModelCalls: 0,
          syntheticPairCalls: analysisCalls,
          databasePath: path.join(directory, "demo.sqlite"),
        });
        return;
      }
      if (pathname === "/__knowledge_demo/request" && req.method === "POST") {
        void (async () => {
          const frame = await body(req);
          if (typeof frame.method !== "string" || !isRecord(frame.params)) {
            throw new Error("Invalid preview frame");
          }
          const personalWiki = await personalWikiPreview({
            actorKey,
            method: frame.method,
            params: frame.params,
          });
          if (personalWiki.handled) {
            json(res, { ok: true, payload: personalWiki.result });
            return;
          }
          const common = {
            agentId: actor.binding.agentId,
            method: frame.method,
            request: frame.params,
            now: Date.now(),
          };
          const knowledge = await requestBrowserOrganizationKnowledge({
            ...common,
            store,
            service,
          });
          if (knowledge.handled) {
            json(res, { ok: true, payload: knowledge.result });
            return;
          }
          if (
            frame.method === "platformclaw.memory.lifecycle" ||
            frame.method.startsWith("platformclaw.memory.promotion.")
          ) {
            const lifecycle = await requestBrowserOrganizationMemoryLifecycle({
              ...common,
              lifecycle: store,
            });
            if (lifecycle.handled) {
              json(res, { ok: true, payload: lifecycle.result });
              return;
            }
          }
          if (frame.method === "platformclaw.memory.graph") {
            const graph = await requestBrowserOrganizationMemoryGraph({
              ...common,
              get: (request) => store.getOrganizationMemoryGraph(request),
            });
            json(res, {
              ok: true,
              payload: graph.handled ? graph.result : null,
            });
            return;
          }
          if (frame.method === "platformclaw.memory.get" && typeof frame.params.path === "string") {
            const document = await requestBrowserOrganizationMemoryGet({
              ...common,
              get: (request) => store.getOrganizationMemory(request),
            });
            json(res, {
              ok: true,
              payload: document.handled ? document.result : null,
            });
            return;
          }
          throw new BrowserGatewayProxyError(
            "method-not-allowed",
            "DEMO supports knowledge review only",
          );
        })().catch((error: unknown) =>
          json(res, {
            ok: false,
            error: {
              code: error instanceof BrowserGatewayProxyError ? error.code : "UNAVAILABLE",
              message:
                error instanceof BrowserGatewayProxyError ? error.message : "DEMO request failed",
            },
          }),
        );
        return;
      }
      if (pathname === "/" || pathname.startsWith("/platformclaw/app")) {
        res.setHeader("Set-Cookie", `demoActor=${actorKey}; Path=/; SameSite=Strict`);
      }
      next();
    });
  },
  transformIndexHtml(html) {
    return html.replace(
      "</head>",
      `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'>
      <script>${bannerScript}</script><script src="/__knowledge_demo/bootstrap.js"></script></head>`,
    );
  },
};
const server = await createServer({
  configFile: path.join(repoRoot, "ui/vite.config.ts"),
  root: path.join(repoRoot, "ui"),
  base: "/",
  cacheDir: path.join(directory, "vite"),
  plugins: [plugin],
  server: { host: "127.0.0.1", port, strictPort: true, allowedHosts: ["127.0.0.1", "localhost"] },
});
await server.listen();
console.log(
  `DEMO_PREVIEW_URL=http://127.0.0.1:${port}/platformclaw/app/settings/memory/organization?demoActor=A`,
);
console.log(`DEMO_DATA_DIRECTORY=${directory}`);
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await server.close();
await service.close();
store.close();
