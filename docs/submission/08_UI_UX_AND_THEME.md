---
summary: "PlatformClaw login, theme, role, 실행 상태와 접근성 요구사항"
read_when:
  - "제출 UI, screenshot 또는 demo 화면을 검토할 때"
title: "UI/UX와 Theme"
---

# UI/UX와 Theme

PlatformClaw Theme는 색상 교체가 아니라 사용자가 identity, Agent, Workspace, Execution Target과 Run 상태를 즉시 이해하게 하는 운영 surface다.

## 구현 Surface

- Login과 local mascot: `ui/src/platformclaw/login.ts`, `login.css`, `login-mascot.ts`
- brand/title/favicon: `branding.ts`, `web-contract.ts`, `favicon-employee.svg`
- restricted employee shell: `control-ui-adapter.ts`
- execution target: `execution-settings.ts`
- personal/admin MCP: `mcp-settings.ts`, `mcp-administration.ts`
- VM admin: `vm-administration.ts`
- theme: `ui/src/styles/platformclaw-theme.css`, `platformclaw-theme-chat.css`
- Korean copy: `ui/src/platformclaw/locales/ko.ts`

상태: `IMPLEMENTED` for source/test; actual demo screenshot는 `INTERNAL_INTEGRATION_REQUIRED`(`IR-009`, `IR-011`).

## Required visible facts

- 로그인 identity alias
- Personal 또는 Group Agent
- Workspace 의미
- `platform_server` 또는 `assigned_vm`
- VM assignment/connection/credential readiness
- current Run과 live tool activity
- error와 다음 행동
- retry/loading/empty state
- employee/admin role 차이
- Group의 personal VM/credential 금지

## Accessibility와 layout

keyboard focus, label, contrast, reduced motion, responsive layout, long text wrapping과 error announcement를 유지한다. mascot은 고정 비율로 작게 사용하고 pixel rendering에서 왜곡하지 않는다.

## Authorization

navigation hiding은 편의 기능일 뿐 보안 경계가 아니다. server proxy가 method, params, result와 event를 user/Agent/session owner에 고정한다. browser에는 administrator credential과 generic Gateway config를 노출하지 않는다.

## 테스트

- `ui/src/e2e/platformclaw-login.e2e.test.ts`
- `ui/src/e2e/platformclaw-theme.e2e.test.ts`
- `ui/src/e2e/platformclaw-adapter.e2e.test.ts`
- `ui/src/e2e/platformclaw-execution-settings.e2e.test.ts`
- `ui/src/e2e/platformclaw-vm-administration.e2e.test.ts`
- `ui/src/e2e/platformclaw-mcp-settings.e2e.test.ts`
- `ui/src/styles/theme-contrast.test.ts`

## Demo capture

Mock screenshot에는 화면 안에 `MOCK`을 표시하고 alias/dummy endpoint만 사용한다. actual screenshot은 사내에서 private data를 마스킹한 뒤 `actual-golden-run/`에 저장하고 final gate로 검사한다.
