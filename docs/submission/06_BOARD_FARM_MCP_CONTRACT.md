---
summary: "Board Farm lease, adapter, hardware validation과 evidence 계약"
read_when:
  - "Board Farm Mock 또는 실제 사내 adapter를 구현·검증할 때"
title: "Board Farm MCP Contract"
---

# Board Farm MCP Contract

## 상태와 범위

Board Farm domain contract와 deterministic Mock adapter는 `MOCK_VERIFIED`다. 실제 사내 MCP adapter, authentication, Tool과 endpoint는 `INTERNAL_INTEGRATION_REQUIRED`(`IR-001`, `IR-002`)이며 외부 branch에서 완료로 표현하지 않는다.

## Domain owner

`packages/platformclaw-control-plane/src/board-farm/`이 Run, build gate, lease ownership, lifecycle과 evidence reference를 소유한다. MCP adapter는 내부 transport mapping만 소유한다. 이 분리는 Mock와 actual adapter가 동일한 domain contract를 통과하게 한다.

## Required operations

| Operation      | 입력                                                         | 성공 결과                           | 핵심 오류                                        |
| -------------- | ------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------ |
| `lease`        | Run/user/Agent, resource criteria, idempotency key, deadline | lease ID, resource alias, expiry    | build-not-ready, unavailable, timeout, forbidden |
| `renew`        | lease ID, owner, expected revision                           | new expiry/revision                 | stale, expired, forbidden                        |
| `deploy`       | lease ID, artifact digest/ref                                | deployment result                   | digest mismatch, lease expired                   |
| `boot`         | lease ID, deployment revision                                | boot result                         | deploy missing, timeout                          |
| `validate`     | lease ID, validation profile                                 | observations, result, evidence refs | boot missing, validation failed                  |
| `release`      | lease ID, owner, reason                                      | released state                      | forbidden, stale revision                        |
| `recoverStale` | authoritative lease snapshot                                 | recovered/released result           | still active, owner conflict                     |

## Invariants

1. successful build result와 artifact digest 없이는 `lease` 불가
2. 한 resource의 active exclusive lease는 하나
3. renew/release/deploy/boot/validate는 original user/Agent/Run owner와 revision 검증
4. timeout과 stale recovery는 terminal fact와 evidence를 남김
5. validation/report/notification 실패가 build·lease evidence를 삭제하지 않음
6. retry는 동일 idempotency key의 기존 결과를 재사용
7. adapter error는 stable code, retryability와 operator next action을 반환
8. secret/internal endpoint는 result/evidence에 포함하지 않음

## Lease State

정상 경로는 `queued → active → releasing → released`다. heartbeat와 bounded `renew`는 `active` 상태의 expiry metadata를 갱신한다. cancellation은 `cancelling → cancelled`, stale/deadline expiry는 `expiring → expired`로 진행한다. cleanup 실패는 `cleanup_failed`와 quarantined resource를 남기며 `retryCleanup` 또는 restart `recover`가 다시 처리한다. 상태 이름과 exact schema는 `board-farm/contracts.ts`, `schema.ts`, `state-machine.ts`가 기준이다.

## Mock와 Actual

`mock-adapter.ts`는 deterministic resource와 실패 injection을 제공한다. Mock evidence는 `mode: mock`이고 실제 hardware 정보가 없다. 사내 adapter는 `submission/internal-templates/board-farm-mcp/adapter.template.ts`가 가리키는 interface와 acceptance test를 구현하고, actual result는 `actual-golden-run/`에만 쓴다.

## Acceptance

- build failure 후 lease call 0회
- cross-user renew/release/deploy 거부
- timeout, renewal, stale recovery, cancellation, cleanup 검증
- validation failure에도 evidence 유지
- restart 후 lease state 복구
- actual adapter contract test가 secret을 출력하지 않고 통과
