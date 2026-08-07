# Board Farm MCP External Component

Board Farm MCP server는 PlatformClaw 외부의 독립 repository와 service다. `packages/` 또는 `extensions/`에 포함하지 않는다. 이 디렉터리는 해커톤 평가자가 외부 component의 역할, provenance와 연결 증거를 확인하는 제출 위치다.

## 권장 구조

```text
submission/external-components/board-farm-mcp/
├─ README.md
├─ source/       # 필요할 때만 sanitized source snapshot
├─ tests/        # 공개 가능한 contract/dry-run tests
└─ EVALUATION.md # PlatformClaw 연결 지점과 실행 방법
```

## 제출 방법

1. 심사자가 원본 repository에 접근할 수 있으면 이 문서에 repository URL, exact commit SHA, license와 재현 명령을 기록한다. source를 중복 복사하지 않는다.
2. 원본 repository가 private이고 공개 가능한 구현을 평가에 포함해야 하면 `.git/`을 제외한 sanitized snapshot만 `source/`에 둔다.
3. snapshot에는 원본 commit SHA, 생성 시점과 제외한 private surface를 기록한다.
4. private URL, endpoint, credential, board identifier, raw log와 사내 정책값을 넣지 않는다.
5. private submodule은 심사자 checkout이 실패할 수 있으므로 사용하지 않는다.

## PlatformClaw 연결

PlatformClaw 쪽 client contract는 `packages/platformclaw-control-plane/src/board-farm/`, integration template은 `submission/internal-templates/board-farm-mcp/`가 소유한다. 서버 source와 PlatformClaw adapter source를 같은 component로 표현하지 않는다.

현재 원본 repository metadata와 actual source는 아직 제공되지 않았으므로 `INTERNAL_INTEGRATION_REQUIRED`다.
