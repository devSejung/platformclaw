---
summary: "PlatformClaw HELLO AI 제출 문서의 읽기 순서와 상태·evidence 규칙"
read_when:
  - "HELLO AI 제출 문서의 기준과 읽기 순서를 확인할 때"
title: "HELLO AI 제출 문서"
---

# HELLO AI 제출 문서

이 디렉터리는 심사 요구사항에서 제품 범위, 보안, 운영, 테스트, business value, code map과 사내 인계까지 이어지는 한국어 source of truth다.

## 읽는 순서

1. `00_EVALUATION_REQUIREMENTS.md`: 공식 안내의 익명 요구사항
2. `01_PRODUCT_SCOPE.md`: KEEP/REMOVE/RETAIN_BUT_HIDDEN 범위
3. `02_USER_SCENARIOS.md`: personal, group, admin workflow
4. `03_SECURITY_AND_ISOLATION.md`~`09_OPERATIONS_FAILURE_RECOVERY.md`: 구현·정책
5. `10_TESTING_AND_CI.md`: proof와 gate
6. `11_BUSINESS_VALUE.md`: 현재·목표 workflow와 측정 계획
7. `12_CODE_MAP.md`: claim별 code/test/runtime path
8. `13_DECISIONS_AND_TRADEOFFS.md`: 선택과 대안
9. `14_INTERNAL_HANDOFF.md`: `IR-001`~`IR-013`
10. `15_DEMO_PLAN.md`: 5분 이내 영상 runbook
11. `16_EXTERNAL_PREP_REPORT.md`: 외부 준비 검토 결과

## 상태값

문서, YAML과 evidence는 다음 값만 사용한다.

- `VERIFIED_IMPLEMENTED`: source, focused test와 runtime proof가 존재
- `IMPLEMENTED`: source와 test가 존재하지만 별도 runtime proof가 필수는 아님
- `IMPLEMENTED_WITH_LIMITATIONS`: 동작 경계는 있으나 production/integration 제한 존재
- `MOCK_VERIFIED`: 실제 domain path를 deterministic Mock로 검증
- `INTERNAL_INTEGRATION_REQUIRED`: 사내 system/secret/asset이 필요
- `PROPOSED`: 설계만 있고 구현 claim이 아님
- `OUT_OF_SCOPE`: 제출 목표에 포함하지 않음

`submission/evaluation-map.yaml`이 claim 상태의 기준이고, `submission/internal-requirements.yaml`이 사내 작업 기준이다.

## Evidence 규칙

`submission/evidence/mock-golden-run/`은 `mode: mock`인 외부 proof다. `submission/evidence/actual-golden-run/`은 사내 actual 실행에만 사용한다. Mock 파일을 actual path로 복사하거나 실제 hardware 결과로 서술하지 않는다.
