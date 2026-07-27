# Release notes contract

Use Korean operator-facing prose and this exact section order:

```markdown
# PlatformClaw VM Preview (YYYY-MM-DD)

회사 환경 반입 전 검증용 prerelease입니다. 대상 commit은 `<full-sha>`입니다.

## 포함 내용

- User-visible and operator-visible changes

## 배포 자산

- Image transfer archive and checksum
- Home-managed deployment bundle and checksum
- Release manifest

## 검증

- Exact commands, CI jobs, Docker smoke, and review result

## 설치와 업데이트

- `platformclaw-deploy` quick path
- Existing state migration or compatibility note

## 주의

- Remaining external configuration, risk, and rollback limits
```

State facts only. Name skipped proof. Never include private URLs, account IDs,
tokens, API keys, certificates, logs, databases, or workspace content.
