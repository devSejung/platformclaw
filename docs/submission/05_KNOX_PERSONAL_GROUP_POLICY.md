---
summary: "Knox DM과 Group Room의 identity, Agent, execution과 delivery 정책"
read_when:
  - "Knox routing과 personal/group 보안 차이를 확인할 때"
title: "Knox Personal/Group 정책"
---

# Knox Personal/Group 정책

## Owner boundary

`extensions/knox`는 transport envelope, webhook auth, normalization, outbound presentation을 소유한다. Personal/room Agent와 execution target 선택은 `KnoxRoutingService`가 소유한다. Channel plugin이 product identity나 개인 VM 정책을 추측하지 않는다.

## DM 정책

1. CDEP가 서명한 inbound message의 원문 bytes를 검증한다.
2. `knoxUserId`를 변형하지 않고 Control Plane에 전달한다.
3. prior Web login으로 연결된 active user만 Personal Agent `main` session을 사용한다.
4. 현재 personal execution target을 route 결과로 전달한다.
5. unknown user는 login guidance를 받고 Agent run을 시작하지 않는다.
6. final response의 VM/Basic 표시만 outbound presentation에서 붙인다.

상태: `IMPLEMENTED_WITH_LIMITATIONS`; 실제 CDEP proof는 `IR-007`.

## Group Room 정책

| 항목                        | 정책                                                          |
| --------------------------- | ------------------------------------------------------------- |
| Agent                       | room별 `group-{chatroomId}`                                   |
| Session                     | 해당 Agent의 `main`                                           |
| Personal Agent              | 사용 금지                                                     |
| Personal VM                 | 사용 금지                                                     |
| Personal SSH/MCP credential | 사용 금지                                                     |
| Execution                   | Agent-scoped policy Docker Sandbox                            |
| Workspace                   | group Agent owner                                             |
| Sender                      | linked user 여부를 context로 전달하되 personal 권한 부여 금지 |

concurrent first message는 single-flight provisioning으로 한 binding을 만든다. disabled/failed room은 silent drop하지 않고 명시적 result를 반환한다.

상태: `IMPLEMENTED_WITH_LIMITATIONS`.

## Delivery

- fast run은 progress를 생략할 수 있다.
- slow run은 bounded progress message를 최대 한 번 보낸다.
- final, error, timeout은 visible message가 되어야 한다.
- duplicate inbound/outbound는 idempotency key로 중복 실행·전송을 막아야 한다.
- RTF escape와 size/chunk limit은 rendering 후 적용한다.

구현 근거: `extensions/knox/src/inbound.ts`, `outbound.ts`, `webhook-auth.ts`, `normalize.ts`와 테스트.

## Secret과 배포

Webhook secret과 service token은 `*_FILE` secret mount로 전달한다. 실제 Knox API base URL, system ID, authorization과 내부 endpoint는 source·docs·evidence에 기록하지 않는다.

상태: config/runtime contract는 `IMPLEMENTED`; actual delivery는 `INTERNAL_INTEGRATION_REQUIRED`(`IR-007`).

## Acceptance

- DM은 existing personal Agent/target 사용
- Web 미활성 DM은 login guidance
- Group은 room Agent/Sandbox 사용
- Group의 personal VM·credential access 거부
- dotted/underscored sender ID 보존
- duplicate, error, timeout, retry가 visible/durable
- actual screenshot/log는 sanitized
