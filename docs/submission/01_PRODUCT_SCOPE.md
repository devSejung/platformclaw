---
summary: "PlatformClaw 제출 runtime의 KEEP, REMOVE, RETAIN_BUT_HIDDEN 범위"
read_when:
  - "upstream 기반 경로와 PlatformClaw 제출 surface를 구분할 때"
title: "제출 제품 범위"
---

# 제출 제품 범위

제출 runtime의 첫 화면과 Golden Path는 PlatformClaw다. upstream generic core와 plugin ecosystem은 ancestry·dependency를 보존하되, consumer channel 중심 surface는 사용자 경로에서 숨긴다.

## 분류 기준

- `KEEP`: 제출 runtime 또는 generic contract에 직접 필요
- `REMOVE`: dependency closure와 license를 포함해 안전하게 제거 가능하고 실제 삭제됨
- `RETAIN_BUT_HIDDEN`: upstream sync 또는 dependency 때문에 유지하지만 제출 제품 surface에 노출하지 않음

## Path Matrix

| Path                                             | Origin       | Purpose                                             | Runtime | Closure                             | 분류              | 이유                           | 검증                            |
| ------------------------------------------------ | ------------ | --------------------------------------------------- | ------- | ----------------------------------- | ----------------- | ------------------------------ | ------------------------------- |
| `packages/platformclaw-control-plane/`           | PlatformClaw | identity, authorization, VM, credential, Board Farm | 사용    | 직접                                | KEEP              | enterprise owner               | focused tests/build             |
| `extensions/platformclaw-execution/`             | PlatformClaw | assigned VM backend                                 | 사용    | 직접                                | KEEP              | plugin boundary                | extension tests                 |
| `extensions/platformclaw-user-mcp/`              | PlatformClaw | personal MCP credential injection                   | 사용    | 직접                                | KEEP              | secret isolation               | extension tests                 |
| `extensions/knox/`                               | PlatformClaw | Knox transport와 routing client                     | 사용    | 직접                                | KEEP              | 제출 ingress                   | extension tests                 |
| `extensions/admin-http-rpc/`                     | PlatformClaw | bounded admin RPC                                   | 사용    | 직접                                | KEEP              | admin boundary                 | plugin tests                    |
| `ui/src/platformclaw/`                           | PlatformClaw | login, brand, execution/MCP/admin UI                | 사용    | 직접                                | KEEP              | primary Web UX                 | UI tests/build                  |
| `docker/platformclaw-runtime/`                   | PlatformClaw | Linux deployment, rootless Sandbox                  | 사용    | 직접                                | KEEP              | final runtime                  | Compose + smoke                 |
| `src/agents/`, `src/gateway/`, `src/plugin-sdk/` | Upstream     | generic Agent/Gateway/SDK                           | 사용    | 직접                                | KEEP              | core contract                  | upstream gates                  |
| upstream consumer channel plugin paths           | Upstream     | 범용 message transport                              | 미사용  | package exports, build/test catalog | RETAIN_BUT_HIDDEN | 제출 runtime에서 비활성·비노출 | product copy + dependency audit |
| upstream native app paths                        | Upstream     | consumer/native clients                             | 미사용  | protocol/release/test tooling       | RETAIN_BUT_HIDDEN | 제출 runtime에서 비빌드·비노출 | submission scope audit          |
| unrelated providers/skills/docs/tests/workflows  | Upstream     | upstream ecosystem                                  | 미사용  | upstream maintenance                | RETAIN_BUT_HIDDEN | 안전한 deletion closure 미입증 | changed-surface gate            |
| remote upstream README banner                    | Upstream     | upstream marketing                                  | 미사용  | 없음                                | REMOVE            | 제출 first impression과 무관   | README local asset scan         |
| `CONTRIBUTING.md`                                | Upstream     | upstream 기여·community·PR 안내                     | 미사용  | root docs 참조만 존재               | REMOVE            | 제출/runtime과 무관            | link audit + CI                 |

## 제품 Surface 정책

- browser title, favicon, Login, primary navigation, setup, slide, demo는 PlatformClaw다.
- employee route에서 개인 assistant channel setup과 unsupported provider 홍보를 노출하지 않는다.
- `@openclaw/*`, Gateway Protocol, Plugin SDK, migration·CLI 이름은 내부 호환성 때문에 유지한다.
- 삭제 대신 숨김을 선택한 경로는 source ownership을 왜곡하지 않으며 license와 upstream sync를 보존한다.

## 삭제 Audit

제출 branch에서 consumer channel 4개와 native app 3개를 실제 조사했다. 대상만 3,468 tracked files, 약 55MB이며, 경로 밖에서 package exports, bundled-plugin build, package-boundary config, protocol guards, release scripts, test classifiers와 CI가 직접 참조한다. 따라서 현재 상태에서 디렉터리만 삭제하면 다음 삭제 조건을 만족하지 못한다.

- pnpm workspace·lockfile과 package exports 정상 갱신
- plugin catalog·generic protocol·build tooling 동시 갱신
- 관련 docs·tests·workflow 전체 closure 검증
- 전체 제출 build와 CI 통과

이 경로는 PlatformClaw 기능이어서 남긴 것이 아니다. fork dependency closure를 깨지 않기 위한 `RETAIN_BUT_HIDDEN`이며 제출 runtime의 configured plugin, UI navigation, setup, slides, demo와 지원 기능 목록에는 포함하지 않는다. 향후 제거는 별도 upstream-divergence 작업으로 수행하고, 위 closure를 모두 통과할 때만 `REMOVE`로 바꾼다.

## 검증 명령

```bash
node scripts/platformclaw-check.mjs --changed --quick
pnpm submission:slides:check
pnpm submission:verify:external
```

대규모 삭제는 workspace, lockfile, catalog, Docker, tests, docs와 CI를 동시에 검증하기 전에는 수행하지 않는다.
