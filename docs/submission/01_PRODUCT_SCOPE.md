---
summary: "PlatformClaw 제출 runtime의 KEEP, REMOVE, RETAIN_BUT_HIDDEN 범위"
read_when:
  - "OpenClaw 기반 경로와 PlatformClaw 제출 surface를 구분할 때"
title: "제출 제품 범위"
---

# 제출 제품 범위

제출 runtime의 첫 화면과 Golden Path는 PlatformClaw다. OpenClaw generic core와 plugin ecosystem은 ancestry·dependency를 보존하되, consumer channel 중심 surface는 사용자 경로에서 숨긴다.

## 분류 기준

- `KEEP`: 제출 runtime 또는 generic contract에 직접 필요
- `REMOVE`: dependency closure와 license를 포함해 안전하게 제거 가능하고 실제 삭제됨
- `RETAIN_BUT_HIDDEN`: upstream sync 또는 dependency 때문에 유지하지만 제출 제품 surface에 노출하지 않음

## Path Matrix

| Path                                             | Origin       | Purpose                                             | Runtime | Closure              | 분류              | 이유                           | 검증                    |
| ------------------------------------------------ | ------------ | --------------------------------------------------- | ------- | -------------------- | ----------------- | ------------------------------ | ----------------------- |
| `packages/platformclaw-control-plane/`           | PlatformClaw | identity, authorization, VM, credential, Board Farm | 사용    | 직접                 | KEEP              | enterprise owner               | focused tests/build     |
| `extensions/platformclaw-execution/`             | PlatformClaw | assigned VM backend                                 | 사용    | 직접                 | KEEP              | plugin boundary                | extension tests         |
| `extensions/platformclaw-user-mcp/`              | PlatformClaw | personal MCP credential injection                   | 사용    | 직접                 | KEEP              | secret isolation               | extension tests         |
| `extensions/knox/`                               | PlatformClaw | Knox transport와 routing client                     | 사용    | 직접                 | KEEP              | 제출 ingress                   | extension tests         |
| `extensions/admin-http-rpc/`                     | PlatformClaw | bounded admin RPC                                   | 사용    | 직접                 | KEEP              | admin boundary                 | plugin tests            |
| `ui/src/platformclaw/`                           | PlatformClaw | login, brand, execution/MCP/admin UI                | 사용    | 직접                 | KEEP              | primary Web UX                 | UI tests/build          |
| `docker/platformclaw-runtime/`                   | PlatformClaw | Linux deployment, rootless Sandbox                  | 사용    | 직접                 | KEEP              | final runtime                  | Compose + smoke         |
| `src/agents/`, `src/gateway/`, `src/plugin-sdk/` | OpenClaw     | generic Agent/Gateway/SDK                           | 사용    | 직접                 | KEEP              | core contract                  | upstream gates          |
| `extensions/telegram/`                           | OpenClaw     | Telegram channel                                    | 미사용  | workspace            | RETAIN_BUT_HIDDEN | upstream sync와 catalog 유지   | product copy scan       |
| `extensions/whatsapp/`                           | OpenClaw     | WhatsApp channel                                    | 미사용  | workspace            | RETAIN_BUT_HIDDEN | same                           | product copy scan       |
| `extensions/discord/`                            | OpenClaw     | Discord channel                                     | 미사용  | workspace            | RETAIN_BUT_HIDDEN | same                           | product copy scan       |
| `extensions/slack/`                              | OpenClaw     | Slack channel                                       | 미사용  | workspace            | RETAIN_BUT_HIDDEN | same                           | product copy scan       |
| `apps/ios/`, `apps/android/`, desktop app paths  | OpenClaw     | consumer/native clients                             | 미사용  | upstream repository  | RETAIN_BUT_HIDDEN | wholesale deletion 위험        | submission scope audit  |
| unrelated providers/skills/docs/tests/workflows  | OpenClaw     | upstream ecosystem                                  | 미사용  | upstream maintenance | RETAIN_BUT_HIDDEN | 안전한 deletion closure 미입증 | changed-surface gate    |
| remote OpenClaw README banner                    | OpenClaw     | upstream marketing                                  | 미사용  | 없음                 | REMOVE            | 제출 first impression과 무관   | README local asset scan |

## 제품 Surface 정책

- browser title, favicon, Login, primary navigation, setup, slide, demo는 PlatformClaw다.
- employee route에서 개인 assistant channel setup과 unsupported provider 홍보를 노출하지 않는다.
- `@openclaw/*`, Gateway Protocol, Plugin SDK, migration·CLI 이름은 내부 호환성 때문에 유지한다.
- 삭제 대신 숨김을 선택한 경로는 source ownership을 왜곡하지 않으며 license와 upstream sync를 보존한다.

## 검증 명령

```bash
node scripts/platformclaw-check.mjs --changed --quick
pnpm submission:slides:check
pnpm submission:verify:external
```

대규모 삭제는 workspace, lockfile, catalog, Docker, tests, docs와 CI를 동시에 검증하기 전에는 수행하지 않는다.
