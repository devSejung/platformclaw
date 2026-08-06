# Board Farm Lease Policy

## Invariants

- failed build는 `build_failed` Run으로 끝나고 lease를 만들지 않는다.
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

상태와 schema의 source of truth는 `packages/platformclaw-control-plane/src/board-farm/contracts.ts`와 `schema.ts`다.
