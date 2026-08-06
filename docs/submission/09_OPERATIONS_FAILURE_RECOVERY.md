---
summary: "PlatformClaw failure owner, retry, restart recovery와 cleanup 정책"
read_when:
  - "운영 failure scenario와 복구 proof를 준비할 때"
title: "운영, 실패와 복구"
---

# 운영, 실패와 복구

## 운영 원칙

모든 사용자 action은 visible outcome 또는 기록된 intentional non-outcome으로 끝난다. 실패 상태는 producer가 기록하고, consumer가 여러 간접 신호로 추측하지 않는다.

## Failure Matrix

| Failure                          | Owner              | 즉시 결과                       | Retry/Recovery                | Evidence                |
| -------------------------------- | ------------------ | ------------------------------- | ----------------------------- | ----------------------- |
| employee auth reject/unavailable | Auth client        | session 미생성, user-safe error | retry policy                  | auth result             |
| Agent provisioning conflict      | Control            | binding failed                  | next login/restart reconcile  | failure code            |
| Gateway unavailable              | ingress/proxy      | 503 visible                     | supervisor retry              | service log alias       |
| VM connection/host key failure   | execution owner    | `connection_required`           | candidate re-probe            | allocation failure code |
| credential missing/rotated       | vault/broker       | fail closed                     | replace, new revision         | secret 없는 metadata    |
| build failure                    | Build Skill        | workflow failed                 | source fix/retry              | build result/log refs   |
| lease timeout/stale              | Board domain       | explicit terminal/recovery      | bounded retry/reconcile       | lease result            |
| deploy/boot/validation failure   | Board adapter      | workflow failed                 | policy retry                  | collected evidence 유지 |
| Jira failure                     | Jira Skill         | report failed                   | idempotent retry              | Run/evidence 유지       |
| Knox delivery failure            | Notification Skill | delivery failed                 | idempotent retry              | Run/report 유지         |
| cancellation                     | workflow owner     | cancelled                       | cleanup then optional new run | cancellation fact       |

## Restart Reconciliation

`RestartReconciler`는 public listener 이전 incomplete provisioning을 검사한다. exact Gateway Agent/Workspace/profile ownership이 확인되면 active로 전환하고, missing/conflict는 failed fact로 남긴다. transient dependency failure는 startup을 실패시켜 supervisor가 재시도하게 하고 state를 임의 변경하지 않는다.

상태: `IMPLEMENTED`.

## Retry

- attempt마다 시작/종료를 기록하되 correlation ID와 idempotency key는 보존
- non-retryable authorization, owner, digest mismatch는 자동 retry 금지
- external service backoff는 `retryable`과 `retryAfter` contract를 따름
- timeout 확대나 broad fallback으로 원인을 가리지 않음
- report/notification retry가 build/board operation을 반복하지 않음

## Cleanup

- browser logout: session revoke, requester runtime dispose 요청
- credential rotation/delete: requester MCP runtime과 SSH lease retire
- VM allocation release/revoke: active target 재검증
- board release/cancel: resource owner와 revision 검증
- process restart: stale lease와 incomplete state reconcile
- evidence: cleanup 대상이 아닌 named product artifact

## Observability

Run ID, correlation ID, attempt, owner alias, target revision, artifact digest, lease ID alias, result status와 evidence path를 기록한다. secret, personal identifier와 internal endpoint는 기록하지 않는다.

## Actual proof

사내 Golden Run에서 정상 경로와 최소 한 개 failure→retry/recovery를 수행한다. `IR-009`, `IR-010`, `IR-012`가 완료되기 전에는 production recovery를 검증했다고 표현하지 않는다.
