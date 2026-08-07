# Board Farm Lease Policy

## Invariants

- lease authorization은 build status가 아니라 authenticated user/Agent/Run owner와 실제 MCP resource policy를 따른다.
- queue ordering은 canonical sequence를 사용한다.
- 한 board에는 live lease가 하나만 존재한다.
- lease access는 user ID, lease ID와 one-shot access token을 함께 검증한다.
- access token 원문은 반환 시 한 번만 노출하고 state에는 hash만 저장한다.
- heartbeat/renew는 maximum lifetime을 넘지 않는다.
- release/cancel/expiry는 cleanup을 실행하고 terminal state를 기록한다.
- cleanup failure는 resource를 `quarantined`로 남겨 재할당하지 않는다.
- restart reconciliation은 authoritative lease/resource state에서 시작한다.

## State

Lease: `queued`, `active`, `releasing`, `cancelling`, `expiring`, `released`, `cancelled`, `expired`, `cleanup_failed`.

Run: `build_failed`, `queued`, `leased`, `deploying`, `booting`, `validating`, `succeeded`, `failed`, `cancelled`.

Resource: `available`, `leased`, `cleanup_pending`, `quarantined`.

위 Lease 상태는 Mock lifecycle에서 검증한 최소 안전 불변식이다. 실제 MCP state와 revision mapping은 `IR-001`, `IR-002`에서 확정한다. `packages/platformclaw-control-plane/src/board-farm/contracts.ts`와 `schema.ts`의 `build_failed` Run은 completed build result에서 시작하는 Mock harness 상태이며 실제 MCP lease prerequisite가 아니다.
