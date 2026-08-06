# Board Farm MCP Adapter Contract

사내 adapter는 `BoardFarmAdapter`를 구현한다. lease queue, ownership, access token hash, state transition과 evidence persistence는 Control Plane이 소유하며 adapter가 다시 구현하지 않는다.

## Methods

- `deploy(BoardFarmDeployOperation)`
- `boot(BoardFarmAdapterOperation)`
- `validate(BoardFarmAdapterOperation)`
- `cleanup(BoardFarmCleanupOperation)`

모든 method는 `BoardFarmAdapterResult`를 반환한다. transport error를 throw할 수 있지만 credential, raw internal URL 또는 board serial을 message에 포함하지 않는다. Domain service가 생성한 `operationId`를 MCP idempotency key로 mapping한다.

## Evidence

`BoardFarmEvidenceInput`의 `locator`는 저장소에서 안전하게 참조 가능한 alias/path이고, `sha256`은 lowercase 64-hex digest다. phase별 raw internal artifact는 approved evidence store에 두고 제출 저장소에는 sanitized copy만 둔다.

## Integration

1. `adapter.template.ts`를 사내 source owner로 이동한다.
2. approved MCP SDK/client types를 직접 import한다.
3. process startup factory에서 actual adapter를 구성한다.
4. auth와 endpoint는 deployment secret/config로 주입한다.
5. Mock adapter와 동일 domain acceptance suite를 실행한다.

상태: `INTERNAL_INTEGRATION_REQUIRED`(`IR-001`, `IR-002`).
