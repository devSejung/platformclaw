---
summary: "Board Farm lease, adapter, hardware validation과 evidence 계약"
read_when:
  - "Board Farm Mock 또는 실제 사내 adapter를 구현·검증할 때"
title: "Board Farm MCP Contract"
---

# Board Farm MCP Contract

## 상태와 범위

Board Farm lease lifecycle과 deterministic closed-loop harness는 `MOCK_VERIFIED`다. 실제 사내 MCP adapter, authentication, Tool schema와 endpoint는 `INTERNAL_INTEGRATION_REQUIRED`(`IR-001`, `IR-002`)이며 외부 branch에서 완료로 표현하지 않는다.

## Domain owner

`packages/platformclaw-control-plane/src/board-farm/`은 completed build result에서 시작하는 deterministic Mock Run, lease ownership/lifecycle과 evidence reference를 소유한다. 실제 보드 자원과 lease·renew·control·release 동작은 사내 Board Farm MCP가 소유한다. Control Plane은 authenticated user/Agent/Run context를 전달하고 결과를 기록해야 하지만, exact Tool 이름·schema·auth를 모르는 외부 branch에서 Mock contract를 실제 MCP contract로 고정하지 않는다.

## Required operations

| Operation      | 입력                                                         | 성공 결과                           | 핵심 오류                       |
| -------------- | ------------------------------------------------------------ | ----------------------------------- | ------------------------------- |
| `lease`        | Run/user/Agent, resource criteria, idempotency key, deadline | lease ID, resource alias, expiry    | unavailable, timeout, forbidden |
| `renew`        | lease ID, owner, expected revision                           | new expiry/revision                 | stale, expired, forbidden       |
| `deploy`       | lease ID, artifact digest/ref                                | deployment result                   | digest mismatch, lease expired  |
| `boot`         | lease ID, deployment revision                                | boot result                         | deploy missing, timeout         |
| `control`      | lease ID, owner, approved board action                       | bounded action result, evidence     | unsupported, expired, forbidden |
| `validate`     | lease ID, validation profile                                 | observations, result, evidence refs | boot missing, validation failed |
| `release`      | lease ID, owner, reason                                      | released state                      | forbidden, stale revision       |
| `recoverStale` | authoritative lease snapshot                                 | recovered/released result           | still active, owner conflict    |

## Invariants

1. lease는 build status가 아니라 실제 MCP의 resource availability와 authenticated owner policy로 결정
2. 한 resource의 active exclusive lease는 하나
3. renew/release/deploy/boot/validate는 original user/Agent/Run owner와 revision 검증
4. timeout과 stale recovery는 terminal fact와 evidence를 남김
5. build/validation/report/notification 실패가 기존 lease·evidence를 삭제하지 않음
6. retry는 동일 idempotency key의 기존 결과를 재사용
7. adapter error는 stable code, retryability와 operator next action을 반환
8. secret/internal endpoint는 result/evidence에 포함하지 않음

## Lease State

정상 경로는 `queued → active → releasing → released`다. heartbeat와 bounded `renew`는 `active` 상태의 expiry metadata를 갱신한다. cancellation은 `cancelling → cancelled`, stale/deadline expiry는 `expiring → expired`로 진행한다. cleanup 실패는 `cleanup_failed`와 quarantined resource를 남기며 `retryCleanup` 또는 restart `recover`가 다시 처리한다. 상태 이름과 exact schema는 `board-farm/contracts.ts`, `schema.ts`, `state-machine.ts`가 기준이다.

## Mock와 Actual

`mock-adapter.ts`는 completed build result를 입력받아 deterministic resource와 실패 injection을 제공한다. failed build를 short-circuit하는 동작은 Mock Golden Run의 orchestration 편의이며 실제 MCP lease 제한이 아니다. Mock evidence는 `mode: mock`이고 실제 hardware 정보가 없다. 사내 integration은 `submission/internal-templates/board-farm-mcp/`의 미정 항목을 실제 Tool schema로 채우고, actual result는 `actual-golden-run/`에만 쓴다.

## Acceptance

- build 결과와 무관하게 authorized lease 요청 계약을 검증
- artifact가 없는 deploy는 거부하되 lease 자체의 권한과 혼동하지 않음
- active owned lease에서 approved control action을 실행하고 evidence를 기록
- cross-user renew/release/deploy 거부
- timeout, renewal, stale recovery, cancellation, cleanup 검증
- validation failure에도 evidence 유지
- restart 후 lease state 복구
- actual MCP contract test가 secret을 출력하지 않고 통과
