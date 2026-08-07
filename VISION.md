# PlatformClaw Vision

PlatformClaw는 여러 개발자가 각자의 Personal Agent를 통해 자신이 소유한 개발 공간과 할당된 VM에서 안전하게 작업하고, 그 결과를 실제 보드 검증까지 연결하는 멀티유저 AI 엔지니어링 플랫폼이다.

## 제품 방향

- Personal Agent는 인증된 사용자의 Workspace, VM, credential만 사용한다.
- Group Agent는 개인 자원에 접근하지 않고 승인된 공용 Sandbox만 사용한다.
- 코드 수정과 빌드는 개인 개발 VM에서 수행한다.
- 빌드 산출물은 Board Farm MCP를 통해 lease, deploy, boot, control, validation 단계로 전달한다.
- 모든 단계는 하나의 Run과 correlation ID로 연결하고, 결과·실패·증거를 명시적으로 남긴다.
- 여러 사용자가 동시에 사용해도 사용자·Agent·Workspace·VM·credential 경계가 섞이지 않아야 한다.

## 구현 원칙

- 권한은 UI가 아니라 서버의 request, result, event 경계에서 검사한다.
- credential은 암호화 저장하고 실행 시점에 one-shot으로 전달한다.
- 내부 endpoint, 인증 방식, Global Skills와 실제 측정값은 공개 저장소에 넣지 않는다.
- Mock 결과와 actual 결과를 디렉터리, manifest, gate에서 분리한다.
- 실제 사내 연동을 모르면 추측하지 않고 `INTERNAL_INTEGRATION_REQUIRED`와 `TODO(INTERNAL)`로 남긴다.
- 제출 runtime과 문서는 PlatformClaw Golden Path에 집중한다. 직접 관련 없는 consumer channel과 native app은 노출하지 않는다.

## 완료 기준

공개 범위에서는 identity, ownership, personal VM execution, Sandbox, credential, Board Farm domain contract와 deterministic Mock closed loop를 검증한다. 최종 사내 완료는 실제 MCP·Global Skills·Jira·Knox 연결, actual Golden Run, 측정값, 5분 영상과 final gate 통과로 판단한다.
