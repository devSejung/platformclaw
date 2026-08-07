# HELLO AI 평가 근거

PlatformClaw는 여러 사용자의 Personal Agent가 각자의 개인 개발 VM에 접속하고 Board Farm MCP를 사용하도록 격리하는 멀티유저 AI 엔지니어링 플랫폼이다. 이 문서는 공식 5개 항목을 각각 독립적으로 읽을 수 있게 구성한다. 점수를 요청하지 않으며, 현재 코드·테스트·Runtime evidence와 제한을 함께 제시한다. 세부 claim의 기준은 `submission/evaluation-map.yaml`이다.

## 기술성 — 30%

**문제.** 여러 사용자의 identity, session, Workspace, VM, credential과 하드웨어 lease를 한 agent runtime에 연결하면 교차 사용자 노출, stale target 실행, 중복 lease와 secret 누출 위험이 생긴다.

**주장.** PlatformClaw는 identity와 실행의 owner boundary를 Control Plane에 두고, request/result/event를 personal Agent로 고정하며, credential을 encrypted envelope와 one-shot local handoff로 전달한다. 각 사용자는 자신의 개인 개발 VM에서 코드 수정과 빌드를 수행하고, Board Farm MCP lease·control은 별도 integration boundary로 연결한다.

**실제 구현.** `packages/platformclaw-control-plane/src/`가 principal, session, provisioning, VM allocation, target revision, encrypted SSH/MCP state와 audit를 소유한다. `extensions/platformclaw-execution/src/`는 assigned VM backend, bounded SSH master lease, remote skill snapshot을 구현한다. `docker/platformclaw-runtime/`은 rootless Docker endpoint와 secret mount를 분리한다.

**비자명한 난제.** 같은 사용자에 대한 concurrent provisioning single-flight, request뿐 아니라 result/event projection까지의 tenant authorization, 사용자별 VM allocation과 Workspace 고정, credential revision이 바뀔 때 기존 SSH lease retirement, restart 중 provisioning reconciliation, DNS-pinned OAuth SSRF boundary와 board lease owner isolation이 핵심이다.

**코드 근거.** `browser-auth-service.ts`, `browser-gateway-proxy.ts`, `execution-handoff-service.ts`, `ssh-credential-vault.ts`, `mcp-credential-vault.ts`, `extensions/platformclaw-execution/src/ssh-lease-manager.ts`, `packages/platformclaw-control-plane/src/board-farm/`.

**테스트 근거.** 동명 `*.test.ts`, `browser-gateway-proxy*.test.ts`, `execution-store.test.ts`, `extensions/platformclaw-execution/src/*.test.ts`.

**Runtime 근거.** `scripts/e2e/platformclaw-runtime-docker.sh`; Board Farm 전체는 `submission/evidence/mock-golden-run/`.

**현재 상태.** Control Plane·VM·credential·Sandbox는 `IMPLEMENTED`; Board Farm workflow는 `MOCK_VERIFIED`; 실제 adapter와 auth는 `INTERNAL_INTEGRATION_REQUIRED`.

**제한과 사내 완료.** 실제 Board Farm endpoint와 Tool mapping이 없어 hardware 성능을 주장하지 않는다. `IR-001`, `IR-002`, `IR-004`, `IR-005`, `IR-009`.

## 창의성 — 25%

**문제.** 범용 AI assistant나 단순 IDE agent는 메시지 응답과 코드 생성은 제공하지만, 기업 identity·개인 VM·group room·실물 보드·Jira·메신저 결과를 한 ownership model로 닫지 않는다.

**주장.** PlatformClaw의 차별점은 personal/group execution policy와 실제 hardware validation을 하나의 traceable Run으로 결합한 데 있다.

**실제 구현.** personal Agent는 사용자에게 할당된 개인 개발 `assigned_vm` 또는 rootless Docker를 선택하고, Knox room Agent는 personal VM·credential 없이 group Sandbox만 사용한다. Board Farm 코드는 외부에서 closed-loop와 owner lifecycle을 검증하는 Mock harness이며, 실제 MCP Tool·lease·control schema는 `IR-001`, `IR-002`에서 별도로 연결한다.

**비자명한 난제.** channel이 product policy를 추측하지 않게 Control Plane이 route와 target을 결정하고, Mock가 실제처럼 보이지 않으면서도 production domain state machine을 통과하도록 evidence를 구조화했다.

**코드 근거.** `knox-routing-service.ts`, `execution-contracts.ts`, `extensions/knox/src/`, `extensions/platformclaw-execution/src/`, `packages/platformclaw-control-plane/src/board-farm/`.

**테스트 근거.** `knox-routing-service.test.ts`, `extensions/knox/src/*.test.ts`, board-farm tests, Mock Golden Path gate.

**Runtime 근거.** `submission/evidence/mock-golden-run/manifest.json`의 `mode: mock`과 단계별 result.

**현재 상태.** policy integration은 `IMPLEMENTED_WITH_LIMITATIONS`; closed-loop 전체는 `MOCK_VERIFIED`.

**제한과 사내 완료.** 실제 사내 자산과 integration 결과 없이 즉시 활용 가능하다고 주장하지 않는다. `IR-001`~`IR-010`.

## 완성도 — 20%

**문제.** 주요 기능이 있어도 login, loading, error, retry, reconnect, failure evidence가 끊기면 운영자는 workflow 결과를 이해할 수 없다.

**주장.** 제출 branch는 PlatformClaw login/theme, 제한된 employee UI, target/MCP 설정, Docker smoke, deterministic Mock Golden Path와 자동 submission gate를 제공한다.

**실제 구현.** `ui/src/platformclaw/`가 login, branding, execution/MCP/admin projection을 제공하고 `ui/src/e2e/platformclaw-*.e2e.test.ts`가 role과 UI state를 검증한다. `scripts/platformclaw-check.mjs`와 submission scripts가 경로·문서·slide·evidence 정합성을 검사한다.

**비자명한 난제.** 브라우저 UI hiding과 서버 authorization을 분리하고, reconnect에도 owner context를 유지하며, Mock/Actual evidence를 서로 다른 directory와 gate로 강제한다.

**코드 근거.** `ui/src/platformclaw/`, `ui/src/styles/platformclaw-theme*.css`, `packages/platformclaw-control-plane/src/web-ingress-*.ts`, `scripts/submission/`.

**테스트 근거.** `ui/src/e2e/platformclaw-login.e2e.test.ts`, `platformclaw-theme.e2e.test.ts`, `platformclaw-execution-settings.e2e.test.ts`, control-plane HTTP tests.

**Runtime 근거.** Docker runtime smoke와 external submission gate; Mock evidence.

**현재 상태.** 외부 demo surface는 `MOCK_VERIFIED`; 실제 hardware/Jira/Knox·MP4는 `INTERNAL_INTEGRATION_REQUIRED`.

**제한과 사내 완료.** 실제 screenshot·video·failure recovery proof는 사내에서 생성한다. `IR-009`~`IR-012`.

## 비즈니스 가치 — 15%

**문제.** 엔지니어가 IDE, VM, build, Board Farm, Jira, Knox를 오가면 handoff·대기·오류 진단 비용과 audit 누락이 생긴다.

**주장.** PlatformClaw는 사용자의 기존 대화 진입점에서 실행과 실제 보드 검증까지 연결하고, Run 단위 evidence를 보고와 알림에 재사용하여 tool switching과 수동 증거 정리를 줄이는 구조다.

**실제 구현.** identity/Agent/Workspace/VM 경계와 운영 UI는 구현돼 있다. Board Farm/Jira/Knox의 외부 branch 결과는 Mock이고, internal template은 production adapter가 구현해야 할 입력·출력·failure contract를 고정한다.

**비자명한 난제.** 편의성을 위해 personal credential을 group flow로 재사용하지 않으며, 보안 경계를 유지한 채 결과만 공유한다. 실측 전 수치를 만들지 않도록 metric schema와 actual evidence gate를 분리한다.

**코드 근거.** `packages/platformclaw-control-plane/`, `extensions/platformclaw-execution/`, `extensions/knox/`, `submission/internal-templates/`.

**테스트 근거.** control-plane, execution, Knox tests와 `scripts/submission/check-internal-requirements.mjs`.

**Runtime 근거.** 외부 Mock evidence만 존재하며 actual metric은 비어 있어야 한다.

**현재 상태.** 적용 구조는 `IMPLEMENTED_WITH_LIMITATIONS`; 사업 효과의 실측은 `INTERNAL_INTEGRATION_REQUIRED`.

**제한과 사내 완료.** `IR-009`, `IR-010`에서 동일 baseline과 실제 run으로 전후 지표를 측정한다.

## 전달력 — 10%

**문제.** final commit만 보는 독립 평가자는 claim과 source·test·evidence가 흩어지면 실제와 계획을 구분하기 어렵다.

**주장.** README의 3분 funnel, 16개 architecture diagram, criterion별 독립 설명, evaluation map, offline slide, Mock/Actual 분리와 internal checklist로 claim에서 근거까지 deterministic하게 이동할 수 있다.

**실제 구현.** `README.md`, `PRD.md`, `ARCHITECTURE.md`, 이 문서, `ATTRIBUTION.md`, `docs/submission/`, `submission/`이 역할별로 분리돼 있다.

**비자명한 난제.** 공식 메일의 PII와 원문 HTML을 복사하지 않고 평가 의미와 1·3·5 anchor를 보존했으며, 외부 기반과 사내 자산을 분리하고 Mock를 실제처럼 표현하지 않는다.

**코드 근거.** `scripts/submission/check-document-consistency.mjs`, `check-blindness.mjs`, `check-evaluation-map.mjs`.

**테스트 근거.** `pnpm submission:verify:external`.

**Runtime 근거.** `submission/slides/index.html`은 offline asset만 사용하며 video runbook은 `submission/video/`에 있다.

**현재 상태.** 제출 문서와 slide는 `IMPLEMENTED`; 실제 MP4는 `INTERNAL_INTEGRATION_REQUIRED`.

**제한과 사내 완료.** 실제 화면과 evidence로 slide·README를 갱신하고 `IR-011`, `IR-012`를 완료해야 한다.
