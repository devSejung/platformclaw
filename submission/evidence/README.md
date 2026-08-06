# Evidence

`mock-golden-run/`과 `actual-golden-run/`은 서로 다른 신뢰 수준이다.

- Mock: external fixture와 deterministic adapter, 반드시 `mode: mock`
- Actual: 사내 VM·Build·Board·Jira·Knox 실행, 반드시 sanitized

공통 manifest는 source commit, Run ID, correlation ID, generated time, user/resource alias, commands, result와 evidence path를 가진다. secret, personal identifier, internal hostname, raw credential과 runtime database를 포함하지 않는다.

Mock path는 final claim의 `actual_evidence_paths`로 사용할 수 없다. actual path를 채우기 전 `INTERNAL_INTEGRATION_REQUIRED` 상태를 유지한다.
