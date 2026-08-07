# Board Farm MCP Adapter Contract

현재 `BoardFarmAdapter`는 deterministic Mock Golden Run의 deploy·boot·validate·cleanup phase interface다. 실제 사내 MCP lease/control contract로 간주하지 않는다. 사내 연동에서는 approved MCP schema를 확인한 뒤 authenticated user/Agent/Run context를 전달하는 lease·renew·control·release seam을 `IR-001`에서 추가한다.

## Methods

- `deploy(BoardFarmDeployOperation)`
- `boot(BoardFarmAdapterOperation)`
- `validate(BoardFarmAdapterOperation)`
- `cleanup(BoardFarmCleanupOperation)`

실제 MCP에는 최소한 lease, renew/heartbeat, approved control action과 release가 필요하다. exact Tool 이름, request/response와 오류 schema는 외부에서 추측하지 않고 사내 담당자가 이 문서와 `adapter.template.md`의 `TODO(INTERNAL)`을 채운다.

모든 method는 `BoardFarmAdapterResult`를 반환한다. transport error를 throw할 수 있지만 credential, raw internal URL 또는 board serial을 message에 포함하지 않는다. Domain service가 생성한 `operationId`를 MCP idempotency key로 mapping한다.

## Evidence

`BoardFarmEvidenceInput`의 `locator`는 저장소에서 안전하게 참조 가능한 alias/path이고, `sha256`은 lowercase 64-hex digest다. phase별 raw internal artifact는 approved evidence store에 두고 제출 저장소에는 sanitized copy만 둔다.

## Integration

1. approved MCP 문서에서 lease·renew·control·release와 deploy/boot/validate Tool schema를 확정한다.
2. `adapter.template.md`의 예제를 사내 source owner로 옮기고 `TODO(INTERNAL)`을 구현한다.
3. approved MCP SDK/client types를 직접 import한다.
4. process startup factory에서 actual integration을 구성한다.
5. auth와 endpoint는 deployment secret/config로 주입한다.
6. actual acceptance suite와 sanitized Golden Run을 실행한다.

상태: `INTERNAL_INTEGRATION_REQUIRED`(`IR-001`, `IR-002`).
