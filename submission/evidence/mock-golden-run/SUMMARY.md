# MOCK Golden Run 요약

이 결과는 실제 사내 Board Farm, 실제 보드, Jira 또는 Knox를 사용하지 않은 **MOCK** 증거다. 실제 PlatformClaw 인증·개인 Agent·상태 저장 코드와 Board Farm 도메인 서비스를 결정적 adapter로 통과한다.

- Run: `golden-run-000001`
- Resource: `mock-board-001`
- Workflow: build → lease → deploy → boot → validate → report → Knox-style result
- Isolation: User B의 User A run 조회가 `not_authorized`로 거절됨
- Recovery: 저장 snapshot을 다시 적재한 뒤 run 조회와 release 성공
- Secret handling: session·lease raw token은 어떤 evidence에도 기록하지 않음
