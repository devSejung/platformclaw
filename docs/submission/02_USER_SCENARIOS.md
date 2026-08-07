---
summary: "Web, Knox DM, Knox Group, 관리자와 Mock 사용자 scenario"
read_when:
  - "identity, Agent, Workspace와 execution 정책을 mode별로 확인할 때"
title: "사용자 Scenario"
---

# 사용자 Scenario

## 정책 Matrix

| Mode               | Identity Source            | Agent Owner       | Workspace Owner    | Session Scope                            | Backend                  | Personal VM     | Docker         | Credential    | Skill           | MCP               | Filesystem       | Audit/Cleanup |
| ------------------ | -------------------------- | ----------------- | ------------------ | ---------------------------------------- | ------------------------ | --------------- | -------------- | ------------- | --------------- | ----------------- | ---------------- | ------------- |
| Web 개인           | enterprise auth            | user              | personal Agent     | personal Agent `main` 또는 owned session | Basic/assigned VM        | 허용            | Basic 필수     | personal      | target snapshot | global + personal | owned Workspace  | Control/user  |
| Knox DM            | raw Knox ID → Web identity | user              | personal Agent     | personal `main`                          | selected personal target | 허용            | Basic 시 필수  | personal      | target snapshot | global + personal | owned Workspace  | Control/user  |
| Knox Group Room    | room                       | room binding      | group Agent        | group Agent `main`                       | policy Sandbox           | 금지            | 필수           | personal 금지 | global approved | personal 금지     | group Workspace  | Control/room  |
| 관리자             | admin auth                 | 관리 대상         | 관리 대상          | admin operation                          | control service          | assignment 관리 | 직접 실행 아님 | admin-owned   | global policy   | global registry   | bounded metadata | administrator |
| System Service     | service identity           | 호출 owner        | 없음 또는 explicit | correlation-bound                        | private service          | 직접 선택 금지  | policy         | one-shot only | 없음            | exact server      | 없음             | service owner |
| External Mock Demo | fixture identity           | fixture user/room | fixture            | deterministic                            | Mock target              | simulated       | test only      | dummy only    | template        | mock              | fixture tree     | Mock runner   |

## Web Personal Golden Path

1. employee login이 principal을 canonical user로 upsert한다.
2. Personal Agent binding을 reserve하고 Gateway Agent/Workspace/profile ownership을 검증한다.
3. opaque browser session을 발급하고 token hash만 저장한다.
4. UI가 identity, Agent와 current Execution Target을 표시한다.
5. request/result/event는 personal Agent와 owned session으로 재검증된다.
6. Basic은 rootless Docker, assigned VM은 revision-pinned SSH backend로 실행한다.
7. Agent가 개인 개발 VM에서 코드 수정과 빌드를 수행하고, 별도 Board Farm MCP로 보드를 lease·control한다.

현재 상태: `IMPLEMENTED_WITH_LIMITATIONS`; actual 사내 Golden Run은 `IR-009`.

## Knox DM

Web에서 활성화된 account만 existing Personal Agent의 `main` session으로 route한다. unknown user는 visible login guidance를 받고 Gateway로 전달되지 않는다. 응답의 execution indicator는 presentation boundary에서만 붙고 transcript에는 들어가지 않는다.

현재 상태: `IMPLEMENTED_WITH_LIMITATIONS`; 실제 CDEP delivery는 `IR-007`.

## Knox Group Room

room별 `group-{chatroomId}` Agent를 single-flight provisioning한다. 개인 Agent, VM, credential, personal MCP와 분리한다. 연결되지 않은 participant도 room Agent만 사용할 수 있고 personal resource로 승격되지 않는다.

현재 상태: `IMPLEMENTED_WITH_LIMITATIONS`; 실제 membership 및 CDEP proof는 `IR-007`, `IR-009`.

## Administrator

관리자는 user state, role, VM endpoint/host/allocation과 global MCP policy를 bounded surface에서 관리한다. employee BFF는 admin secret, generic config mutation과 global session을 노출하지 않는다.

현재 상태: `IMPLEMENTED_WITH_LIMITATIONS`; 내부 deployment RBAC proof는 `IR-008`, `IR-012`.

## Failure Scenario

- authentication failure: session을 만들지 않고 user-safe error
- provisioning conflict: ownership을 overwrite하지 않고 binding failure 기록
- build failure: build result를 명시적으로 남기고 deploy 성공으로 오인하지 않음; 실제 MCP lease 유지·해제 정책은 `IR-001`, `IR-002`에서 확정
- lease timeout/stale: 명시적 terminal/recovery state와 evidence 유지
- validation/report/notification failure: 이전 evidence와 Run 상태 보존
- retry: 같은 correlation ID, 새로운 attempt, idempotency key 보존
- cancellation: lease와 subprocess cleanup owner 명시
