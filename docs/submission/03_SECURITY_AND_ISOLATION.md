---
summary: "PlatformClaw identity, tenant, execution과 credential 보안 경계"
read_when:
  - "사용자 격리와 secret boundary의 근거를 검토할 때"
title: "보안과 격리"
---

# 보안과 격리

## Security invariant

PlatformClaw의 보안 단위는 browser tab이나 UI route가 아니라 authenticated principal → user → Agent binding → session → Workspace → Execution Target의 server-side chain이다.

## Identity와 Session

- employee auth 결과의 stable account/employee identity를 Control Plane에서 canonicalize한다.
- opaque browser token의 hash만 SQLite에 저장한다.
- idle/absolute expiry, revoke, disabled user와 session cap을 검사한다.
- login rate limiter가 client scope별 retry window를 적용한다.

근거: `contracts.ts`, `browser-auth-service.ts`, `browser-login-rate-limiter.ts`와 테스트.

상태: `IMPLEMENTED`.

## User·Agent·Session·Workspace

- Personal Agent ID는 account identity에서 deterministic하게 파생하지만 binding이 ownership authority다.
- Gateway request뿐 아니라 returned row, direct result와 live event를 다시 filter한다.
- browser가 임의 Agent/session을 보내도 authenticated binding으로 pin 또는 reject한다.
- provisioning은 existing workspace/profile owner conflict를 덮어쓰지 않는다.

근거: `browser-gateway-ownership.ts`, `browser-gateway-policy.ts`, `browser-gateway-event-policy.ts`, `browser-gateway-proxy*.test.ts`, `personal-agent-provisioner.test.ts`.

상태: `IMPLEMENTED`.

## VM과 Sandbox

- personal VM은 administrator-approved endpoint/host와 user-owned allocation만 사용한다.
- target revision과 allocation ID를 Run snapshot에 고정한다.
- group room은 personal VM을 사용하지 않고 Agent-scoped Docker Sandbox로 route한다.
- rootless daemon만 Gateway에 제공하며 host Docker socket을 mount하지 않는다.
- arbitrary employee network target은 허용하지 않는다.

상태: `IMPLEMENTED` for code/Docker smoke; actual internal VM은 `INTERNAL_INTEGRATION_REQUIRED`(`IR-009`).

## Credential Boundary

- SSH/MCP credential은 AES-256-GCM authenticated envelope로 SQLite에 저장한다.
- master key는 deployment secret file이고 DB/Gateway/browser와 분리한다.
- Gateway/plugin은 service identity와 exact `agentId`로 one-shot grant를 요청한다.
- secret 원문은 browser response, transcript, Agent Workspace, log 또는 evidence에 기록하지 않는다.
- credential revision이 바뀌면 old requester/SSH lease를 retire한다.

상태: `IMPLEMENTED`.

## Knox Boundary

- inbound raw bytes는 HMAC과 freshness를 확인한 후 normalize한다.
- raw `knoxUserId`는 string으로 보존하고 DM identity lookup에 사용한다.
- group sender는 room Agent만 호출하며 personal linked state를 권한으로 상속하지 않는다.
- error/timeout도 visible outcome으로 전달해야 한다.

실제 CDEP crypto·service credential·endpoint 검증은 `INTERNAL_INTEGRATION_REQUIRED`(`IR-007`).

## Board Farm Boundary

- build success가 lease prerequisite다.
- lease는 requesting user/Agent/Run과 resource를 묶고 cross-user release/renew를 거부한다.
- adapter credential은 browser, model prompt와 evidence에 포함하지 않는다.
- Mock adapter는 production credential을 받지 않는다.

상태: `MOCK_VERIFIED`; actual boundary는 `IR-001`, `IR-002`.

## Secret·PII Checklist

- source에 token, cookie, API key, password, phone, email, employee number, department, internal hostname 금지
- config에는 secret value 대신 `*_FILE` 또는 deployment-owned reference 사용
- screenshot/log는 alias와 public fixture endpoint만 사용
- official mail 원문 commit 금지
- actual evidence 저장 전 `pnpm submission:verify:final` 실행

## Threat-to-proof Matrix

| Threat                       | Control                               | Proof                               |
| ---------------------------- | ------------------------------------- | ----------------------------------- |
| User B가 User A session 조회 | BFF request/result/event filter       | `browser-gateway-proxy*.test.ts`    |
| browser secret 노출          | encrypted store + redacted projection | credential vault/HTTP tests         |
| stale VM target 실행         | revision/allocation revalidation      | execution store/handoff tests       |
| group이 personal VM 사용     | room target policy                    | Knox routing + Sandbox tests        |
| replayed Knox event          | durable ingress contract              | Knox ingress tests; actual `IR-007` |
| duplicate board lease        | idempotency + owner state             | board-farm tests; actual `IR-001`   |
| Mock를 actual로 오인         | directory/mode/final gate 분리        | submission scripts                  |
