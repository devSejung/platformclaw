# Actual Golden Run

이 디렉터리는 사내에서 실제 VM, build, Board Farm, Jira와 Knox를 실행한 sanitized evidence 전용이다. 외부 준비 단계에서는 이 README만 존재한다.

## Required files

- `manifest.json`
- `build-result.json`
- `board-lease-result.json`
- `board-validation-result.json`
- `report-result.json`
- `knox-result.json`
- `verification-result.json`
- `business-metrics.json`
- `video-metadata.json`
- `screenshots/`

## Rules

- `mode`는 `actual`
- source commit과 Run/correlation ID 일치
- user/resource는 alias
- artifact digest와 lease/result reference 포함
- failure→retry/recovery evidence 최소 1개
- metric은 정의, 단위, sample과 baseline 포함
- 개인 정보, secret, token/cookie/key, internal hostname과 private URL 제거
- Mock file을 복사하거나 actual로 이름만 바꾸지 않음

`IR-009`와 `IR-010`을 완료한 뒤 `pnpm submission:verify:final`로 검증한다.
