# PlatformClaw

## 제품

PlatformClaw는 여러 엔지니어가 각자의 Assistant를 통해 사용자 소유의 개인 개발 공간과 assigned VM에 안전하게 접속하도록 하는 멀티유저 AI 엔지니어링 플랫폼이다. 인증된 Web 또는 Knox 요청을 개인·그룹 Agent에 연결하고, 개인 개발 VM 또는 정책 Sandbox에서 코드 수정과 빌드를 수행한 뒤 Board Farm MCP로 보드를 임대·제어하며, 검증·증거·Jira·Knox 결과까지 하나의 추적 가능한 작업으로 완성하는 것을 목표로 한다.

현재 저장소는 OpenClaw의 generic Gateway/Agent/Session/Tool/Plugin/Sandbox 기반을 유지하는 private downstream이다. enterprise 기능은 `packages/platformclaw-control-plane`, private plugins, deployment wrapper와 제한된 UI 경계에 배치한다. upstream ancestry를 보존하며 wholesale fork divergence를 만들지 않는다.

## 현재 구현

- Multi-user identity, browser session, personal Agent provisioning과 request/result/event authorization
- SQLite control state, audit와 restart reconciliation
- Personal VM assignment, SafeConnect/SSH backend, encrypted credential envelope, one-shot broker와 SSH master lease
- rootless Docker Sandbox 정책과 Linux Docker runtime smoke
- personal MCP credential boundary와 administrator-owned global MCP policy
- Knox DM/room routing 계약과 room Agent provisioning
- restricted employee Web ingress와 PlatformClaw login/theme/execution/MCP UI
- remote skill discovery, explicit refresh와 per-run target snapshot
- Board Farm contract와 Mock Golden Path 준비

실제 Board Farm adapter, 사내 Global Skills, Jira 및 Knox 실제 delivery, actual Golden Run과 영상은 `INTERNAL_INTEGRATION_REQUIRED`이다. 상세 상태는 `submission/evaluation-map.yaml`이 기준이다.

## Repository facts

- Development host: Windows
- Final runtime and validation authority: Ubuntu Linux Docker
- `origin`: private PlatformClaw repository
- `upstream`: `https://github.com/openclaw/openclaw.git`
- Submission prep baseline: `dae6d288c6f0d6e543955c13f73a03967b794e6c`
- Confirmed upstream common ancestor: `02457657f012d33e141c710d92671d1bc4a519e9`

## Architecture boundary

- core는 plugin-agnostic을 유지한다.
- enterprise owner-specific behavior는 `packages/platformclaw-control-plane` 또는 private plugin이 소유한다.
- credential은 source, config, browser, transcript, Workspace에 저장하지 않는다.
- runtime state와 plugin KV는 SQLite를 사용한다.
- Windows-only path나 case-insensitive 동작에 의존하지 않는다.
- actual internal evidence는 Mock와 분리한다.

## 개발과 검증

```bash
node scripts/platformclaw-check.mjs --changed --quick
node scripts/platformclaw-check.mjs --changed
pnpm test:docker:platformclaw-runtime
pnpm submission:verify:external
```

사내 연동 후:

```bash
pnpm submission:verify:final
```

Windows linked worktree에서는 `pnpm install`과 tracked `node_modules`에 대한 Git restore/checkout/reset을 실행하지 않는다. primary checkout toolchain 또는 repository wrapper를 재사용한다.

## Git workflow

- `main`: 검증된 PlatformClaw baseline
- `feature/*`: 기능
- `fix/*`: 수정
- `refactor/*`: 구조 개선
- `sync/upstream-YYYYMMDD`: upstream integration
- `submission/hello-ai-2026-prep`: 외부 준비
- `submission/hello-ai-2026-final`: 사내 finalization에서만 생성

upstream 변경은 임시 sync branch에서 검증한 뒤 merge한다. main에 직접 적용하지 않는다.

## 관련 문서

- `README.md`: 3분 제품 진입점
- `PRD.md`: 요구사항과 acceptance
- `ARCHITECTURE.md`: component와 trust boundary
- `EVALUATION.md`: 심사 항목별 독립 근거
- `ATTRIBUTION.md`: upstream·legacy·사내 자산 구분
- `docs/platformclaw/`: 구현·운영 상세
- `docs/submission/`: 제출 근거와 사내 인계
